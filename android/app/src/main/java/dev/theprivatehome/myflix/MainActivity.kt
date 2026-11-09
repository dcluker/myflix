package dev.theprivatehome.myflix

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var errorView: View? = null
    private var retries = 0
    private var lanReauthTried = false   // a LAN 401 first retries with the device header (the cookie may have lapsed)
    private var mainFrameFailed = false
    private var lastRetryAt = 0L

    private var startUrl = Net.myflixBase + "/?tv=1"
    private val myflixHost: String = Uri.parse(Net.myflixBase).host ?: ""

    /** The public MyFlix host, or the LAN one when paired for offline use. */
    private fun isMyflixHost(h: String?) = h != null && (h == myflixHost || Net.isLanHost(h))
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var lastCookieRefresh = 0L
    private var authFailed = false
    private var updateChecked = false
    private var goHomePending = false
    private var pendingCast: String? = null   // item id sent by `am start --es cast_item` (Echo Hub "cast to TV")
    private var pageReady = false
    private var updateLanFetched = false

    companion object {
        // The CF_Authorization cookie lasts ~2 days; renew well inside that so page fetches never
        // run on an expired session (only the main-frame load carries the service-token headers).
        private const val COOKIE_REFRESH_MS = 2 * 60 * 60 * 1000L
        private const val UPDATE_CHECK_MS = 6 * 60 * 60 * 1000L

        /** Launch extra (`adb shell am start -n .../.Home --ez clear_cache true`): see [clearCachesOnly]. */
        const val EXTRA_CLEAR_CACHE = "clear_cache"

        /** Launch extra (`am start -n .../.Home --es cast_item <32-hex item id>`): play that title once the page is up. */
        const val EXTRA_CAST_ITEM = "cast_item"
        private val ITEM_ID = Regex("[0-9a-f]{32}")
    }

    /**
     * Dev/test aid, triggered by the [EXTRA_CLEAR_CACHE] launch extra. Deletes the contents of cacheDir
     * and codeCacheDir (this includes the WebView HTTP cache, so stale JS/CSS is dropped). Cookies,
     * localStorage/WebStorage, shared preferences and the pairing credentials are never touched.
     * Run before the WebView exists so Chromium is not using the files; [clearWebViewCache] follows.
     */
    private fun clearCachesOnly() {
        listOfNotNull(cacheDir, codeCacheDir).forEach { dir ->
            dir.listFiles()?.forEach { runCatching { it.deleteRecursively() } }
        }
    }

    private fun clearWebViewCache() {
        webView.clearCache(true)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Net.paired) {
            PairActivity.start(this)
            finish()
            return
        }
        val clearCache = savedInstanceState == null && intent?.getBooleanExtra(EXTRA_CLEAR_CACHE, false) == true
        pendingCast = castIdFrom(intent)
        if (clearCache) clearCachesOnly()
        // Inspectable over ADB (chrome://inspect) in debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)

        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            isFocusable = true
            isFocusableInTouchMode = true
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = userAgentString + " MyFlixTV AFT"
            }
            webViewClient = Client()
        }
        root.addView(webView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        if (clearCache) clearWebViewCache()
        applyImmersive()
        if (savedInstanceState != null) webView.restoreState(savedInstanceState) else loadStart()
        watchNetwork()
        webView.requestFocus()
    }

    private fun castIdFrom(i: Intent?): String? =
        i?.getStringExtra(EXTRA_CAST_ITEM)?.lowercase()?.takeIf { ITEM_ID.matches(it) }

    /** A cast request while the app is already running (launchMode singleTask re-delivers the launch intent). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val id = castIdFrom(intent) ?: return
        pendingCast = id
        if (pageReady) fireCast()
    }

    private fun fireCast() {
        val id = pendingCast ?: return
        pendingCast = null
        openPlayer(id)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // ---- Follow the network: re-pick LAN vs public when the internet drops or returns ----
    private var netCb: android.net.ConnectivityManager.NetworkCallback? = null
    private var lastValidated: Boolean? = null
    private var lastRebase = 0L

    /** Re-probe and reload only if the best base changed (a page loaded from a dead origin never recovers on its own). */
    private fun rebaseIfNeeded() {
        io.execute {
            Net.resetProbe()
            val nb = Net.activeBase()
            main.post { if (!isDestroyed && !startUrl.startsWith(nb)) loadStart() }
        }
    }

    private fun watchNetwork() {
        val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return
        val cb = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(n: android.net.Network, caps: android.net.NetworkCapabilities) {
                val ok = caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                val was = lastValidated
                lastValidated = ok
                if (was != null && was != ok) main.post {
                    if (ok && !Net.hasLanSecret) updateLanFetched = false   // back online: fetch the missing LAN secret
                    rebaseIfNeeded()
                }
            }
        }
        try { cm.registerDefaultNetworkCallback(cb); netCb = cb } catch (_: Exception) { }
    }

    private fun stopWatchingNetwork() {
        val cb = netCb ?: return
        netCb = null
        try { getSystemService(android.net.ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } catch (_: Exception) { }
    }

    private fun loadStart() {
        mainFrameFailed = false
        lastCookieRefresh = android.os.SystemClock.elapsedRealtime()
        io.execute {
            if (Net.paired && !updateLanFetched) {
                Net.refreshLanCredential()   // keep the LAN secret current while online (silent if offline)
                updateLanFetched = Net.hasLanSecret   // offline with no secret yet: try again on the next load
            }
            val url = Net.activeBase() + "/?tv=1"
            main.post {
                if (isDestroyed) return@post
                startUrl = url
                webView.loadUrl(url, Net.authHeadersFor(url))
            }
        }
    }

    private fun applyImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    override fun onResume() {
        super.onResume()
        if (!::webView.isInitialized) return
        webView.onResume()
        if (goHomePending) goHomeNow()
        if (android.os.SystemClock.elapsedRealtime() - lastCookieRefresh > 30 * 60 * 1000L) refreshCookie()
        main.removeCallbacks(cookieTick)
        main.postDelayed(cookieTick, COOKIE_REFRESH_MS)
        maybeCheckUpdate()
    }

    /** The remote's Home key (also fires when this app starts an activity without NO_USER_ACTION). */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        android.util.Log.i("MyFlix", "onUserLeaveHint -> go home on return")
        goHomePending = true
    }

    private fun goHomeNow() {
        goHomePending = false
        webView.evaluateJavascript("window.__myflixHome&&window.__myflixHome()", null)
    }

    override fun onPause() {
        if (::webView.isInitialized) {
            main.removeCallbacks(cookieTick)
            webView.onPause()
        }
        super.onPause()
    }

    override fun onDestroy() {
        stopWatchingNetwork()
        if (::webView.isInitialized) {
            CookieManager.getInstance().flush()
            webView.destroy()
        }
        io.shutdown()
        super.onDestroy()
    }

    // ---- Access session cookie ----

    private val cookieTick = object : Runnable {
        override fun run() {
            refreshCookie()
            main.postDelayed(this, COOKIE_REFRESH_MS)
        }
    }

    /** Renews CF_Authorization using the service-token headers; the page itself is untouched. */
    private fun refreshCookie() {
        lastCookieRefresh = android.os.SystemClock.elapsedRealtime()
        if (Net.lanActive) return   // LAN session is a server cookie; no Cloudflare cookie to renew
        io.execute {
            val cookies = try { Net.fetchAccessCookies() } catch (_: Exception) { return@execute }
            main.post {
                if (isDestroyed) return@post
                val cm = CookieManager.getInstance()
                cookies.forEach { cm.setCookie(Net.myflixBase, it) }
                cm.flush()
            }
        }
    }

    // ---- Menu: update / re-pair ----

    private fun showMenu() {
        val c = Net.creds
        val who = if (c != null && c.name.isNotEmpty()) "paired as ${c.name}" else "paired"
        AlertDialog.Builder(this)
            .setTitle("MyFlix ${BuildConfig.VERSION_NAME} ($who)")
            .setItems(arrayOf("Check for updates", "Re-pair / sign out")) { _, which ->
                if (which == 0) checkUpdate(manual = true) else confirmSignOut()
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun confirmSignOut() {
        AlertDialog.Builder(this)
            .setTitle("Sign out of MyFlix?")
            .setMessage("This removes the pairing from this device. You will need a new code to connect again." +
                if (Net.lanActive || lastValidated == false) "\n\nPairing needs the internet. Without it this TV can't connect again until the internet is back." else "")
            .setPositiveButton("Sign out") { _, _ -> signOut() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun signOut() {
        Net.setCreds(null)
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData() // drops the saved profile choice
        webView.clearCache(true)
        PairActivity.start(this)
        finish()
    }

    // ---- In-app update ----

    private fun maybeCheckUpdate() {
        if (updateChecked) return
        updateChecked = true
        if (System.currentTimeMillis() - Net.store.lastUpdateCheck < UPDATE_CHECK_MS) return
        checkUpdate(manual = false)
    }

    private fun checkUpdate(manual: Boolean) {
        io.execute {
            val u = Updater.check(Net.client, BuildConfig.TV_BASE, BuildConfig.VERSION_CODE, android.os.Build.VERSION.SDK_INT)
            if (!manual || u != null) Net.store.lastUpdateCheck = System.currentTimeMillis()
            main.post {
                if (isDestroyed || isFinishing) return@post
                if (u != null) offerUpdate(u)
                else if (manual) AlertDialog.Builder(this).setMessage("MyFlix is up to date.").setPositiveButton("OK", null).show()
            }
        }
    }

    private fun offerUpdate(u: UpdateInfo) {
        AlertDialog.Builder(this)
            .setTitle("Update available")
            .setMessage("MyFlix ${u.versionName} is ready to install.")
            .setPositiveButton("Install") { _, _ -> downloadAndInstall(u) }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun downloadAndInstall(u: UpdateInfo) {
        val dlg = AlertDialog.Builder(this).setMessage("Downloading update...").setCancelable(false).show()
        io.execute {
            val f = File(cacheDir, "MyFlix-update.apk")
            val err: String? = try {
                Updater.download(Net.client, u, f, BuildConfig.HOST_SUFFIX, if (BuildConfig.DEBUG) BuildConfig.DEBUG_ALLOW_HOST else "")
                null
            } catch (e: Updater.BadUpdate) {
                "The update failed its safety check and was not installed."
            } catch (e: Exception) {
                "Couldn't download the update. Check the connection and try again."
            }
            main.post {
                dlg.dismiss()
                if (isDestroyed) return@post
                if (err != null) {
                    AlertDialog.Builder(this).setMessage(err).setPositiveButton("OK", null).show()
                    return@post
                }
                try {
                    if (!Updater.install(this, f)) {
                        AlertDialog.Builder(this)
                            .setMessage("Allow MyFlix to install apps in the screen that just opened, then choose Check for updates again.")
                            .setPositiveButton("OK", null).show()
                    }
                } catch (e: Exception) {
                    AlertDialog.Builder(this).setMessage("Couldn't start the install.").setPositiveButton("OK", null).show()
                }
            }
        }
    }

    // ---- Retry / error handling ----

    private fun retryOrFail() {
        if (retries < 2) {
            retries++
            lastRetryAt = android.os.SystemClock.elapsedRealtime()
            loadStart()
        } else {
            showError()
        }
    }

    private fun showError() {
        if (errorView != null) return
        val msg = TextView(this).apply {
            text = if (authFailed) "MyFlix didn't accept this device.\nIt may have been removed. Try again, or re-pair it with a new code."
            else "Can't reach MyFlix.\nCheck the network connection and try again."
            setTextColor(Color.WHITE)
            textSize = 24f
            gravity = Gravity.CENTER
        }
        val btn = Button(this).apply {
            text = "Retry"
            isFocusable = true
            setOnClickListener {
                removeError()
                retries = 0
                authFailed = false
                loadStart()
            }
        }
        val repair = Button(this).apply {
            text = "Re-pair / sign out"
            isFocusable = true
            setOnClickListener { confirmSignOut() }
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            isClickable = true
            addView(msg, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(btn, LinearLayout.LayoutParams(480, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 48 })
            addView(repair, LinearLayout.LayoutParams(480, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 16 })
        }
        errorView = box
        root.addView(box, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        btn.requestFocus()
    }

    private fun removeError() {
        // Only hand focus back when an error screen actually had it: requestFocus() on a WebView
        // that is already focused makes Chromium jump to the page's first control, and this runs
        // on every in-page navigation (opening or closing a title).
        val view = errorView ?: return
        root.removeView(view)
        errorView = null
        webView.requestFocus()
    }

    // ---- Player hand-off ----

    private fun openPlayer(itemId: String, live: Boolean = false) {
        webView.evaluateJavascript("(function(){try{return localStorage.getItem('myflix.profile')}catch(e){return null}})()") { raw ->
            var userId: String? = null
            try {
                if (raw != null && raw != "null") {
                    val s = JSONArray("[$raw]").getString(0)
                    userId = JSONObject(s).optString("userId").ifEmpty { null }
                }
            } catch (_: Exception) {
            }
            if (userId == null) return@evaluateJavascript
            startActivity(Intent(this, PlayerActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION)   // opening the player is not the user leaving
                putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId)
                putExtra(PlayerActivity.EXTRA_PROFILE_ID, userId)
                putExtra(PlayerActivity.EXTRA_LIVE, live)
            })
        }
    }

    // ---- Back key ----

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            if (event.repeatCount == 0) showMenu()
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && !event.isCanceled) {
            if (errorView != null) {
                finish()
                return true
            }
            webView.evaluateJavascript("(function(){return window.__myflixBack && window.__myflixBack()})()") { res ->
                if (res == null || res == "false" || res == "null") finish()
            }
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    // ---- WebViewClient ----

    private inner class Client : WebViewClient() {
        private fun isAccessLogin(host: String?) =
            host != null && (host == "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com"))

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val host = uri.host
            if (isAccessLogin(host)) {
                retryOrFail()
                return true
            }
            if (!isMyflixHost(host)) return true // block everything off-site
            val path = uri.path ?: ""
            if (path.startsWith("/play/")) {
                val id = path.removePrefix("/play/").trimEnd('/').substringBefore('/')
                if (id.isNotEmpty()) openPlayer(id, uri.getQueryParameter("live") == "1")
                return true
            }
            return false
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (isAccessLogin(Uri.parse(url ?: "").host)) {
                view.stopLoading()
                retryOrFail()
            }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            CookieManager.getInstance().flush()
            if (isMyflixHost(Uri.parse(url ?: "").host)) {
                pageReady = true
                if (pendingCast != null) main.postDelayed({ fireCast() }, 600)   // let the SPA restore its saved profile first
            }
            val settled = android.os.SystemClock.elapsedRealtime() - lastRetryAt > 2000
            if (!mainFrameFailed && settled && isMyflixHost(Uri.parse(url ?: "").host)) {
                retries = 0
                lanReauthTried = false
                authFailed = false
                removeError()
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            val denied = errorResponse.statusCode == 401 || errorResponse.statusCode == 403
            if (request.isForMainFrame && denied) {
                if (Net.isLanHost(request.url.host)) {
                    if (!lanReauthTried) {
                        // A page reload carries only the cookie; log in again with the device header (loadStart).
                        lanReauthTried = true
                        lastRetryAt = android.os.SystemClock.elapsedRealtime()
                        loadStart()
                        return
                    }
                    Net.dropLan()   // the header was refused too: try the public URL (secret kept)
                    updateLanFetched = false
                }
                mainFrameFailed = true
                authFailed = true
                retryOrFail()
            } else if (denied && request.url.host == myflixHost && !Net.lanActive &&
                android.os.SystemClock.elapsedRealtime() - lastCookieRefresh > 60_000L
            ) {
                // A page request lost its Access session: renew the cookie so the next one succeeds.
                refreshCookie()
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
            if (failingUrl == view.url || failingUrl == startUrl) {
                mainFrameFailed = true
                showError()
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (!request.isForMainFrame && request.url.host == myflixHost && !Net.lanActive &&
                android.os.SystemClock.elapsedRealtime() - lastRebase > 15_000L
            ) {
                lastRebase = android.os.SystemClock.elapsedRealtime()
                rebaseIfNeeded()
            }
            if (request.isForMainFrame) {
                mainFrameFailed = true
                showError()
            }
        }
    }
}
