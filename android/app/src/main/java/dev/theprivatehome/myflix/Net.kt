package dev.theprivatehome.myflix

import android.content.Context
import android.net.Uri
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class App : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        Net.init(this)
    }
}

object Net {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val json = "application/json".toMediaType()
    lateinit var store: Store
        private set

    @Volatile
    var creds: Credentials? = null
        private set

    fun init(ctx: Context) {
        store = Store(ctx.applicationContext)
        creds = store.load()
        loadLan()
    }

    fun setCreds(c: Credentials?) {
        if (c == null) store.clear() else store.save(c)
        creds = c
    }

    val paired: Boolean get() = creds != null

    // ---- LAN-first (works with the internet down) ----
    @Volatile private var lanBase: String = ""
    @Volatile private var lanSecret: String = ""
    @Volatile private var lanProbeAt = 0L
    @Volatile private var lanProbeOk = false

    private fun loadLan() {
        lanBase = store.lanBase
        lanSecret = store.lanSecret
    }

    /** Auth header for requests to the LAN MyFlix; empty for any other URL. */
    fun lanHeadersFor(url: String): Map<String, String> {
        val c = creds ?: return emptyMap()
        val b = lanBase
        if (b.isEmpty() || lanSecret.isEmpty() || !(url == b || url.startsWith("$b/"))) return emptyMap()
        return mapOf("X-MyFlix-Device" to "${c.clientId}:$lanSecret")
    }

    /** LAN header when [url] is the LAN server, else the Cloudflare service-token headers. */
    fun authHeadersFor(url: String): Map<String, String> = lanHeadersFor(url).ifEmpty { cfHeadersFor(url) }

    fun isLanHost(host: String?): Boolean = lanBase.isNotEmpty() && host != null && host == Uri.parse(lanBase).host

    /** True while the LAN server is the one in use (cookie refresh etc. only apply to the public host). */
    val lanActive: Boolean get() = lanProbeOk

    /**
     * The MyFlix base to use right now: the LAN server when it answers /healthz quickly, else the public URL.
     * Blocking (<= 600 ms); call off the main thread. The result is cached for 20 s.
     */
    fun activeBase(): String {
        val b = lanBase
        if (b.isEmpty() || lanSecret.isEmpty() || !Hosts.isPrivateLanBase(b)) return myflixBase
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lanProbeAt < 20_000L) return if (lanProbeOk) b else myflixBase
        val c = client.newBuilder().callTimeout(600, TimeUnit.MILLISECONDS)
            .connectTimeout(600, TimeUnit.MILLISECONDS).build()
        lanProbeOk = try {
            c.newCall(Request.Builder().url("$b/healthz").build()).execute().use { r ->
                r.isSuccessful && r.body?.string()?.trim() == "ok"
            }
        } catch (_: Exception) {
            false
        }
        lanProbeAt = now
        return if (lanProbeOk) b else myflixBase
    }

    /** Forget the cached base choice so the next [activeBase] re-probes (network changed). */
    fun resetProbe() { lanProbeAt = 0L }

    /**
     * The LAN server rejected even the header login: use the public URL for the next probe window. The secret is
     * kept (a transient 401, e.g. T14 rebooting while the landing box is down, must not strand an offline TV);
     * a fresh one is fetched the next time the public URL answers.
     */
    fun dropLan() {
        lanProbeOk = false
        lanProbeAt = android.os.SystemClock.elapsedRealtime()
    }

    val hasLanSecret: Boolean get() = lanSecret.isNotEmpty()

    /** While online: ask the server for its LAN address + this device's LAN secret, and keep them. Best effort. */
    fun refreshLanCredential() {
        val base = myflixBase
        if (base.isEmpty()) return
        val url = "$base/api/lan-credential"
        try {
            client.newCall(Request.Builder().url(url).cf(url).header("Accept", "application/json").build()).execute().use { r ->
                if (!r.isSuccessful) return
                val j = JSONObject(r.body?.string().orEmpty())
                val lb = j.optString("lanBase").trimEnd('/')
                val ls = j.optString("lanSecret")
                if (lb.isEmpty() || ls.isEmpty() || !Hosts.isPrivateLanBase(lb)) return
                store.lanBase = lb
                store.lanSecret = ls
                loadLan()
                lanProbeAt = 0L
            }
        } catch (_: Exception) {
        }
    }

    val myflixBase: String get() = creds?.myflixBase.orEmpty()
    val deviceLabel: String get() = store.deviceLabel.ifEmpty { Build.MODEL }

    fun pairClient() = PairClient(
        client, BuildConfig.TV_BASE, BuildConfig.HOST_SUFFIX, BuildConfig.DEBUG_ALLOW_HOST,
        BuildConfig.PUBLIC_MYFLIX_BASE, BuildConfig.PUBLIC_JELLYFIN_BASE,
    )

    /**
     * Cloudflare Access service-token headers, only for https hosts under the configured domain
     * (plus the debug-only mock host). Plain-http LAN requests never get them.
     */
    fun cfHeadersFor(url: String): Map<String, String> {
        val c = creds ?: return emptyMap()
        if (!Hosts.cfEligible(url, BuildConfig.HOST_SUFFIX, if (BuildConfig.DEBUG) BuildConfig.DEBUG_ALLOW_HOST else "")) {
            return emptyMap()
        }
        return mapOf(
            "CF-Access-Client-Id" to c.clientId,
            "CF-Access-Client-Secret" to c.clientSecret,
        )
    }

    private fun Request.Builder.cf(url: String): Request.Builder {
        authHeadersFor(url).forEach { (k, v) -> header(k, v) }
        return this
    }

    /** GET /api/playinfo/<id> for the given profile; returns raw JSON text. Throws on failure. */
    fun fetchPlayInfo(itemId: String, profileUserId: String, live: Boolean = false): String {
        val base = activeBase()
        val url = if (live) "$base/api/livetv/play/$itemId" else "$base/api/playinfo/$itemId"
        val req = Request.Builder()
            .url(url)
            .cf(url)
            .header("X-MyFlix-Profile", profileUserId)
            .header("Accept", "application/json")
            .build()
        client.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw PlayInfoException(r.code, body)
            return body
        }
    }

    /** POST /api/livetv/stop: frees the open Jellyfin live stream. Best effort. */
    fun stopLive(liveStreamId: String, profileUserId: String) {
        try {
            val url = "${activeBase()}/api/livetv/stop"
            val body = org.json.JSONObject().put("liveStreamId", liveStreamId).toString()
                .toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url(url).cf(url).header("X-MyFlix-Profile", profileUserId).post(body).build()
            client.newCall(req).execute().use { }
        } catch (_: Exception) {
        }
    }

    /** Image bytes (the title logo shown over the player), or null on any failure. */
    fun fetchImage(url: String): ByteArray? = try {
        client.newCall(Request.Builder().url(url).cf(url).build()).execute().use { r ->
            if (r.isSuccessful) r.body?.bytes() else null
        }
    } catch (_: Exception) {
        null
    }

    /** Returns the Jellyfin server Id answering at [lanBase], or null (<=800 ms, any failure). */
    fun probeLan(lanBase: String): String? {
        if (!Hosts.isPrivateLanBase(lanBase)) return null
        val c = client.newBuilder().callTimeout(800, TimeUnit.MILLISECONDS)
            .connectTimeout(800, TimeUnit.MILLISECONDS).build()
        return try {
            c.newCall(Request.Builder().url(lanBase.trimEnd('/') + "/System/Info/Public").build()).execute().use { r ->
                if (!r.isSuccessful) null else JSONObject(r.body?.string().orEmpty()).optString("Id").ifEmpty { null }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun jellyfinAuth(token: String): String {
        fun esc(s: String) = s.replace("\"", "").replace("\\", "")
        return "MediaBrowser Client=\"MyFlix TV\", Device=\"${esc(Build.MODEL)}\", " +
            "DeviceId=\"${store.deviceId}\", Version=\"${BuildConfig.VERSION_NAME}\", Token=\"$token\""
    }

    /** Jellyfin report (start/progress/stop); failures are swallowed by the caller. */
    fun postJellyfin(base: String, path: String, token: String, body: String) {
        val url = base + path
        val req = Request.Builder()
            .url(url)
            .cf(url)
            .header("Authorization", jellyfinAuth(token))
            .post(body.toRequestBody(json))
            .build()
        client.newCall(req).execute().use { /* ignore body */ }
    }

    /**
     * Fetches a fresh CF_Authorization cookie with the service-token headers and returns the raw
     * Set-Cookie lines. The WebView keeps working from that cookie between main-frame loads.
     */
    fun fetchAccessCookies(): List<String> {
        val url = "$myflixBase/?tv=1"
        val req = Request.Builder().url(url).cf(url).header("Accept", "text/html").build()
        client.newCall(req).execute().use { r ->
            return r.headers("Set-Cookie").filter { it.startsWith("CF_Authorization=") }
        }
    }
}

class PlayInfoException(val code: Int, body: String) : Exception("HTTP $code") {
    val detail: String = body.take(200)

    /** The server's machine-readable `{"error": "..."}` code, when present. */
    val errorCode: String? = try {
        JSONObject(body).optString("error").ifEmpty { null }
    } catch (_: Exception) {
        null
    }
}
