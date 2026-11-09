package dev.theprivatehome.myflix

import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.app.Dialog
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.PlayerView
import androidx.media3.ui.TimeBar
import androidx.media3.ui.TrackSelectionDialogBuilder
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors

@androidx.annotation.OptIn(UnstableApi::class)
class PlayerActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_ITEM_ID = "itemId"
        const val EXTRA_PROFILE_ID = "profileUserId"
        const val EXTRA_LIVE = "live"
        private const val SEEK_MS = 10_000L
        private const val PROGRESS_MS = 10_000L
        private const val NEXT_COUNTDOWN_S = 5
        private const val CREDITS_COUNTDOWN_S = 10
        private const val CREDITS_POLL_MS = 500L
    }

    /** Parsed /api/playinfo response. */
    private class Info(j: JSONObject) {
        val itemId: String = j.getString("itemId")
        val live: Boolean = j.optBoolean("live", false)
        /** Live channel whose streamUrl is the public source (not a Jellyfin URL): use it as-is, never rebase. */
        val direct: Boolean = j.optBoolean("direct", false)
        val liveStreamId: String = j.optString("liveStreamId", "")
        val startPositionMs: Long = j.optLong("startPositionMs", 0)
        /** Legacy field (older servers): the only base they know about. */
        val legacyBase: String = j.optString("jellyfinBase", "")
        val lanBase: String? = j.optString("lanBase").ifEmpty { null }
        val publicBase: String? = j.optString("publicBase").ifEmpty { null }
        val serverId: String? = j.optString("serverId").ifEmpty { null }
        /** The Jellyfin base chosen for this playback (LAN when verified, else public). */
        var base: String = legacyBase
        val token: String = j.getString("token")
        val mediaSourceId: String = j.optString("mediaSourceId", itemId)
        val playSessionId: String = j.optString("playSessionId", "")
        val name: String = j.optString("name", "")
        val seriesName: String = j.optString("seriesName", "")
        val season: Int? = if (j.has("season") && !j.isNull("season")) j.optInt("season") else null
        val episode: Int? = if (j.has("episode") && !j.isNull("episode")) j.optInt("episode") else null
        /** Item whose Logo image names this title: the series for an episode, else the item itself. */
        /** "yyyy-MM-dd" release / air date, when the server knows it. */
        val premiere: String = j.optString("premiere", "")
        val year: Int? = if (j.has("year") && !j.isNull("year")) j.optInt("year") else null
        val logoItemId: String = j.optString("logoItemId", "").ifEmpty { itemId }
        val streamUrl: String = j.getString("streamUrl")
        val videoCodec: String = j.optString("videoCodec", "").ifEmpty { "unknown" }
        val audioCodec: String = j.optString("audioCodec", "").ifEmpty { "unknown" }
        val container: String = j.optString("container", "").ifEmpty { "unknown" }
        val nextEpisodeId: String? =
            if (j.isNull("nextEpisodeId")) null else j.optString("nextEpisodeId").ifEmpty { null }
        /** Where the end credits start; null when unknown. */
        val creditsStartMs: Long? = if (j.has("creditsStartMs")) j.optLong("creditsStartMs") else null
        /** "segment" / "chapter" are real markers (auto-advance); "estimate" is a guess (button only). */
        val creditsMarked: Boolean = j.optString("creditsSource") in setOf("segment", "chapter")
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val reporter = Executors.newSingleThreadExecutor()
    private val probeExecutor = Executors.newCachedThreadPool()

    private lateinit var root: FrameLayout
    private lateinit var playerView: PlayerView
    private var scrubDir = 0
    private var scrubPos = 0L
    private var scrubStartAt = 0L
    private var scrubLastAt = 0L
    private var scrubLastSeekAt = 0L
    private lateinit var statusText: TextView
    private lateinit var titleText: TextView
    private lateinit var titleSub: TextView
    private lateinit var nextOverlay: TextView
    private lateinit var creditsBar: LinearLayout
    private lateinit var nextBtn: TextView
    private lateinit var creditsBtn: TextView
    private var creditsShown = false
    private var creditsDismissed = false
    private var creditsLeft = 0
    private var creditsFocus = 0 // 0 = Next Episode, 1 = Watch Credits
    private var errorBox: View? = null

    // Netflix-style audio / subtitle pills along the bottom, fading with the transport controls.
    private lateinit var controls: FrameLayout
    private lateinit var topRow: LinearLayout
    private lateinit var backBtn: ImageView
    private lateinit var replayBtn: ImageView
    private lateinit var nextTopBtn: ImageView
    private lateinit var playBtn: ImageView
    private lateinit var timeBar: DefaultTimeBar
    private lateinit var elapsedText: TextView
    private lateinit var remainText: TextView
    private var controlsShown = false
    private var openDialogs = 0
    private var playShowsPause = false
    private lateinit var pillScroll: HorizontalScrollView
    private lateinit var pillRow: LinearLayout
    private var pills: List<Pill> = emptyList()
    private var pillSubs: List<TrackDesc> = emptyList()
    private var pillAudioRefs: List<Pair<Tracks.Group, Int>> = emptyList()
    private var pillSubRefs: List<Pair<Tracks.Group, Int>> = emptyList()
    private var pillActive = -1
    private var pillLabels: List<String>? = null
    private var pillFallback = false   // true when the title has one audio track and no subtitles: one fixed pill + Other…

    private var player: ExoPlayer? = null
    private var info: Info? = null
    private var profileId = ""
    private var loadGen = 0
    private var sessionOpen = false
    private var startReported = false
    private var countdownLeft = 0
    private var finishing = false

    private val progressTick = object : Runnable {
        override fun run() {
            report("Progress")
            main.postDelayed(this, PROGRESS_MS)
        }
    }

    /** Watches the position and brings up Next Episode / Watch Credits when the credits start. */
    private val creditsPoll = object : Runnable {
        override fun run() {
            val i = info
            val p = player
            if (i?.nextEpisodeId != null && i.creditsStartMs != null && p != null && !creditsDismissed) {
                val pos = p.currentPosition
                if (!creditsShown && pos >= i.creditsStartMs && p.playbackState == Player.STATE_READY) showCredits(i.creditsMarked)
                else if (creditsShown && pos < i.creditsStartMs - 2000) hideCredits(false) // seeked back
            }
            main.postDelayed(this, CREDITS_POLL_MS)
        }
    }

    private val creditsTick = object : Runnable {
        override fun run() {
            if (!creditsShown) return
            if (creditsLeft <= 0) {
                playNext()
                return
            }
            nextBtn.text = "\u25B6  Next Episode in $creditsLeft"
            creditsLeft--
            main.postDelayed(this, 1000)
        }
    }

    private val countdownTick = object : Runnable {
        override fun run() {
            val next = info?.nextEpisodeId ?: return
            if (countdownLeft <= 0) {
                nextOverlay.visibility = View.GONE
                loadItem(next)
            } else {
                nextOverlay.text = "Next episode in $countdownLeft s  (Back to cancel)"
                countdownLeft--
                main.postDelayed(this, 1000)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        profileId = intent.getStringExtra(EXTRA_PROFILE_ID).orEmpty()
        val itemId = intent.getStringExtra(EXTRA_ITEM_ID).orEmpty()
        liveMode = intent.getBooleanExtra(EXTRA_LIVE, false)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        playerView = PlayerView(this).apply {
            useController = false // MyFlix draws its own Netflix-style controls (buildControls)
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
        }
        statusText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER
            text = "Loading..."
        }
        nextOverlay = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(0xCC000000.toInt())
            setPadding(40, 24, 40, 24)
            textSize = 20f
            visibility = View.GONE
        }
        val dm = resources.displayMetrics.density
        titleText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 30f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setShadowLayer(8f, 0f, 2f, Color.BLACK)
            maxLines = 2
            gravity = Gravity.END
            maxWidth = (640 * dm).toInt()
        }
        titleSub = TextView(this).apply {
            setTextColor(0xFFDDDDDD.toInt())
            textSize = 20f
            setShadowLayer(8f, 0f, 2f, Color.BLACK)
            maxLines = 1
            gravity = Gravity.END
            maxWidth = (640 * dm).toInt()
            visibility = View.GONE
        }
        nextBtn = pill("\u25B6  Next Episode", Color.WHITE, 0xFF141414.toInt())
        creditsBtn = pill("Watch Credits", 0x99333333.toInt(), Color.WHITE)
        creditsBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            addView(creditsBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = 28 })
            addView(nextBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        buildControls(dm)
        root.addView(playerView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(controls, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(
            statusText,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        root.addView(
            nextOverlay,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ).apply { setMargins(0, 0, 64, 96) },
        )
        root.addView(
            creditsBar,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ).apply { setMargins(0, 0, 72, 110) },
        )
        setContentView(root)
        applyImmersive()

        if (itemId.isEmpty() || profileId.isEmpty()) {
            showError("Nothing to play.")
            return
        }
        loadItem(itemId)
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

    // ---- Loading ----

    private var liveMode = false

    private fun loadItem(itemId: String) {
        val gen = ++loadGen
        main.removeCallbacks(countdownTick)
        nextOverlay.visibility = View.GONE
        hideCredits(false)
        creditsDismissed = false
        removeError()
        statusText.text = "Loading..."
        statusText.visibility = View.VISIBLE
        io.execute {
            // Start probing the LAN address while the server builds playinfo (it often takes seconds).
            val earlyProbe = BuildConfig.LAN_JELLYFIN.takeIf { it.isNotEmpty() }?.let { lan ->
                lan to probeExecutor.submit<String?> { Net.probeLan(lan) }
            }
            val result = try {
                val i = Info(JSONObject(Net.fetchPlayInfo(itemId, profileId, liveMode)))
                val lan = i.lanBase
                val probedId = when {
                    lan == null -> null
                    earlyProbe != null && earlyProbe.first.trimEnd('/') == lan.trimEnd('/') ->
                        try { earlyProbe.second.get(2, java.util.concurrent.TimeUnit.SECONDS) } catch (_: Exception) { null }
                    else -> Net.probeLan(lan)
                }
                i.base = Endpoints.choose(lan, i.publicBase, i.legacyBase.ifEmpty { Net.creds?.jellyfinBase.orEmpty() }, i.serverId, probedId)
                Result.success(i)
            } catch (e: Exception) {
                Result.failure(e)
            }
            main.post {
                if (gen != loadGen || isDestroyed || finishing) return@post
                result.fold(
                    onSuccess = { startPlayback(it) },
                    onFailure = { showError(describeFetchError(it)) },
                )
            }
        }
    }

    private fun describeFetchError(e: Throwable): String = when {
        e is PlayInfoException && e.errorCode == "too_high_bitrate" ->
            "This title's file is too large to stream over the internet. Try another title, or watch it on the home network."
        e is PlayInfoException && e.errorCode == "too_many_streams" ->
            "Too many people are streaming right now. Try again in a few minutes."
        e is PlayInfoException && e.code == 404 -> "This title can't be played (no playable media found)."
        e is PlayInfoException && (e.code == 401 || e.code == 403) ->
            "This device isn't allowed to play (HTTP ${e.code}). It may have been removed; press Menu on the home screen to re-pair."
        e is PlayInfoException -> "The server returned an error (HTTP ${e.code})."
        e is IOException -> "Couldn't reach MyFlix. Check the network connection."
        else -> "Couldn't prepare playback: ${e.message ?: e.javaClass.simpleName}"
    }

    private fun ensurePlayer(): ExoPlayer {
        player?.let { return it }
        val factory = DefaultRenderersFactory(this)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
        val p = ExoPlayer.Builder(this, factory)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                true,
            )
            .setSeekBackIncrementMs(SEEK_MS)
            .setSeekForwardIncrementMs(SEEK_MS)
            .build()
        p.addListener(listener)
        playerView.player = p
        player = p
        return p
    }

    private fun startPlayback(i: Info) {
        info = i
        sessionOpen = false
        startReported = false
        clearPills()
        paintTitle(i)
        nextTopBtn.visibility = if (i.nextEpisodeId != null) View.VISIBLE else View.GONE
        showControls()
        val p = ensurePlayer()
        val url = if (i.direct) i.streamUrl else Endpoints.rebase(i.streamUrl, i.base)
        // Cloudflare headers only for https hosts under the configured domain; the LAN stream is plain http without them.
        val http = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(Net.authHeadersFor(url))
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        if (i.live) p.setMediaSource(HlsMediaSource.Factory(http).createMediaSource(MediaItem.fromUri(url)))
        else p.setMediaSource(ProgressiveMediaSource.Factory(http).createMediaSource(MediaItem.fromUri(url)), i.startPositionMs.coerceAtLeast(0))
        p.prepare()
        p.playWhenReady = true
        main.removeCallbacks(creditsPoll)
        main.postDelayed(creditsPoll, CREDITS_POLL_MS)
    }

    /** "April 3, 2015" from the server's yyyy-MM-dd, else just the year, else nothing. */
    private fun releaseText(i: Info): String {
        if (i.premiere.length >= 10) {
            try {
                val d = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).parse(i.premiere.substring(0, 10))
                if (d != null) return java.text.SimpleDateFormat("MMMM d, yyyy", java.util.Locale.US).format(d)
            } catch (_: Exception) {}
        }
        return i.year?.toString().orEmpty()
    }

    /** Top-right title block: bold name, then `S1: E1 "Pilot"` for episodes or the release date for movies. */
    private fun paintTitle(i: Info) {
        val isEp = i.seriesName.isNotEmpty() && i.episode != null
        titleText.text = if (isEp) i.seriesName else i.name
        val sub = if (isEp) Titles.episodeLine(i.season, i.episode, i.name) else releaseText(i)
        titleSub.text = sub
        titleSub.visibility = if (sub.isEmpty()) View.GONE else View.VISIBLE
    }

    // ---- Netflix-style controls ----

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun styleIcon(v: ImageView, solid: Boolean) {
        val f = v.isFocused
        val white = solid || f
        (v.background as GradientDrawable).apply {
            setColor(if (white) Color.WHITE else 0x8C1A1A1A.toInt())
            if (f && solid) setStroke(dp(4), 0xFFE50914.toInt()) else if (!white) setStroke(dp(2), 0x55FFFFFF) else setStroke(0, 0)
        }
        v.setColorFilter(if (white) 0xFF141414.toInt() else Color.WHITE)
        val sc = if (f) 1.14f else 1f
        v.animate().scaleX(sc).scaleY(sc).setDuration(140).start()
    }

    /** Round icon button; [solid] = always a white disc (the play button), else translucent until focused. */
    private fun icon(res: Int, sizeDp: Int, padDp: Int, solid: Boolean): ImageView = ImageView(this).apply {
        setImageResource(res)
        isFocusable = true
        scaleType = ImageView.ScaleType.CENTER_INSIDE
        setPadding(dp(padDp), dp(padDp), dp(padDp), dp(padDp))
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL }
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        setOnFocusChangeListener { v, _ -> styleIcon(v as ImageView, solid) }
        styleIcon(this, solid)
    }

    private fun clockText(w: Int) = TextView(this).apply {
        setTextColor(Color.WHITE)
        textSize = 20f
        gravity = Gravity.CENTER
        minWidth = dp(w)
        setShadowLayer(6f, 0f, 1f, Color.BLACK)
    }

    private fun buildControls(dm: Float) {
        backBtn = icon(R.drawable.ic_ctl_back, 48, 11, false)
        replayBtn = icon(R.drawable.ic_ctl_replay, 48, 11, false)
        nextTopBtn = icon(R.drawable.ic_ctl_next, 48, 11, false)
        topRow = LinearLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            orientation = LinearLayout.HORIZONTAL
            for (b in listOf(backBtn, replayBtn, nextTopBtn)) {
                addView(b, LinearLayout.LayoutParams(dp(48), dp(48)).apply { rightMargin = dp(14) })
            }
        }
        val options = TextView(this).apply {
            text = "OPTIONS"
            setTextColor(0xFFB3B3B3.toInt())
            textSize = 13f
            letterSpacing = 0.15f
            setShadowLayer(6f, 0f, 1f, Color.BLACK)
        }
        val topLeft = LinearLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            setPadding(dp(8), dp(8), dp(8), dp(8))
            orientation = LinearLayout.VERTICAL
            addView(topRow)
            addView(options, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
        }
        val topRight = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.END
            addView(titleText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(titleSub, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val topBar = FrameLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            setPadding(dp(40), dp(20), dp(48), dp(56))
            // Dark fade from the top edge so the title reads over bright scenes.
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xCC000000.toInt(), 0x00000000))
            addView(topLeft, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.TOP))
            addView(topRight, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.TOP))
        }

        playBtn = icon(R.drawable.ic_ctl_play, 64, 16, true)
        elapsedText = clockText(76).apply { text = "00:00" }
        remainText = clockText(84).apply { text = "-00:00" }
        timeBar = layoutInflater.inflate(R.layout.myflix_timebar, null, false) as DefaultTimeBar
        timeBar.addListener(object : TimeBar.OnScrubListener {
            override fun onScrubStart(timeBar: TimeBar, position: Long) {}
            override fun onScrubMove(timeBar: TimeBar, position: Long) {}
            override fun onScrubStop(timeBar: TimeBar, position: Long, canceled: Boolean) {
                if (!canceled) player?.seekTo(position)
            }
        })
        val mainRow = LinearLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            setPadding(dp(8), dp(4), 0, dp(4))
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(playBtn, LinearLayout.LayoutParams(dp(64), dp(64)))
            addView(elapsedText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(14) })
            addView(timeBar, LinearLayout.LayoutParams(0, dp(40), 1f))
            addView(remainText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        pillRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
            clipToPadding = false
        }
        pillScroll = HorizontalScrollView(this).apply {
            isFocusable = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = false
            clipChildren = false
            setPadding(dp(8), dp(10), dp(8), dp(10))
            addView(pillRow, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val bottomGroup = LinearLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            orientation = LinearLayout.VERTICAL
            setPadding(dp(40), dp(56), dp(48), dp(24))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xCC000000.toInt(), 0x00000000))
            addView(mainRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(pillScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        }
        // One group view: it fades as a whole, so nothing (not even the bar) is left behind when it hides.
        controls = FrameLayout(this).apply {
            clipChildren = false
            clipToPadding = false
            visibility = View.GONE
            alpha = 0f
            addView(topBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
            addView(bottomGroup, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        renderPills(emptyList())
    }

    private val hideControlsRun = Runnable { hideControls() }

    private val controlsTick = object : Runnable {
        override fun run() {
            updateControls()
            if (controlsShown) main.postDelayed(this, 250)
        }
    }

    /** Fades the whole control group in (or just restarts the auto-hide timer when already showing). */
    private fun showControls() {
        main.removeCallbacks(hideControlsRun)
        if (openDialogs == 0) main.postDelayed(hideControlsRun, 4000)
        if (controlsShown) return
        controlsShown = true
        controls.animate().cancel()
        controls.visibility = View.VISIBLE
        controls.animate().alpha(1f).setDuration(160).start()
        if (controls.findFocus() == null) playBtn.requestFocus()
        main.removeCallbacks(controlsTick)
        main.post(controlsTick)
    }

    private fun hideControls(immediate: Boolean = false) {
        main.removeCallbacks(hideControlsRun)
        main.removeCallbacks(controlsTick)
        if (!controlsShown && !immediate) return
        controlsShown = false
        controls.animate().cancel()
        if (immediate) {
            controls.alpha = 0f
            controls.visibility = View.GONE
        } else {
            controls.animate().alpha(0f).setDuration(220).withEndAction {
                if (!controlsShown) controls.visibility = View.GONE
            }.start()
        }
    }

    private fun updatePlayIcon() {
        val p = player ?: return
        val pause = p.playWhenReady && p.playbackState != Player.STATE_ENDED
        if (pause != playShowsPause) {
            playShowsPause = pause
            playBtn.setImageResource(if (pause) R.drawable.ic_ctl_pause else R.drawable.ic_ctl_play)
        }
    }

    private fun updateControls() {
        val p = player ?: return
        val dur = if (p.duration == C.TIME_UNSET) 0L else p.duration
        val pos = if (scrubDir != 0) scrubPos else p.currentPosition.coerceAtLeast(0)
        timeBar.setDuration(if (dur > 0) dur else C.TIME_UNSET)
        timeBar.setPosition(pos)
        timeBar.setBufferedPosition(p.bufferedPosition)
        elapsedText.text = TimeFmt.clock(pos)
        remainText.text = TimeFmt.remaining(pos, dur)
        updatePlayIcon()
    }

    private fun togglePlay(p: ExoPlayer) {
        if (p.playWhenReady) p.pause() else p.play()
        updatePlayIcon()
    }

    // ---- Audio / subtitle pills ----

    private fun clearPills() {
        pills = emptyList()
        pillSubs = emptyList()
        pillAudioRefs = emptyList()
        pillSubRefs = emptyList()
        pillActive = -1
        pillFallback = false
        renderPills(emptyList())
    }

    /** Rebuilds the pills from the tracks the player currently exposes. Never throws. */
    private fun refreshPills() {
        try {
            val p = player ?: return clearPills()
            val aRefs = ArrayList<Pair<Tracks.Group, Int>>()
            val sRefs = ArrayList<Pair<Tracks.Group, Int>>()
            for (g in p.currentTracks.groups) {
                val list = when (g.type) {
                    C.TRACK_TYPE_AUDIO -> aRefs
                    C.TRACK_TYPE_TEXT -> sRefs
                    else -> continue
                }
                for (t in 0 until g.length) if (g.isTrackSupported(t, true)) list.add(g to t)
            }
            fun desc(r: Pair<Tracks.Group, Int>): TrackDesc {
                val f = r.first.getTrackFormat(r.second)
                return TrackDesc(f.language, f.label, (f.selectionFlags and C.SELECTION_FLAG_FORCED) != 0)
            }
            val audios = aRefs.map(::desc)
            val subs = sRefs.map(::desc)
            val built = Pills.build(audios, subs)
            val selA = aRefs.indexOfFirst { it.first.isTrackSelected(it.second) }
            val selS = sRefs.indexOfFirst { it.first.isTrackSelected(it.second) }
            pillAudioRefs = aRefs
            pillSubRefs = sRefs
            pillSubs = subs
            pills = built
            pillActive = Pills.active(built, subs, selA, selS)
            pillFallback = built.isEmpty()
            // Like Netflix, the row is always there: a title with a single audio track and no subtitles still
            // shows that track as the (active) pill, then "Other…" and the gear.
            renderPills(if (built.isEmpty()) listOf(Pills.fallbackLabel(audios), "Other\u2026") else built.map { it.label } + "Other\u2026")
        } catch (e: Exception) {
            clearPills()
        }
    }

    /** Lays out [labels] as pills, then the gear icon always last. Keeps focus on the same slot across rebuilds. */
    private fun renderPills(labels: List<String>) {
        if (labels != pillLabels) {
            val focusIdx = (0 until pillRow.childCount).firstOrNull { pillRow.getChildAt(it).isFocused }
            pillLabels = labels
            pillRow.removeAllViews()
            val dm = resources.displayMetrics.density
            val lp = { LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = (12 * dm).toInt(); gravity = Gravity.CENTER_VERTICAL } }
            labels.forEach { _ ->
                val v = TextView(this).apply {
                    isFocusable = true
                    textSize = 18f
                    maxLines = 1
                    gravity = Gravity.CENTER
                    setPadding((22 * dm).toInt(), (10 * dm).toInt(), (22 * dm).toInt(), (10 * dm).toInt())
                    background = GradientDrawable().apply { cornerRadius = 1000f }
                    setOnFocusChangeListener { _, _ -> paintPills() }
                }
                pillRow.addView(v, lp())
            }
            pillRow.addView(icon(R.drawable.ic_ctl_gear, 40, 8, false), lp().apply { width = dp(40); height = dp(40) })
            if (focusIdx != null) pillRow.getChildAt(focusIdx.coerceAtMost(pillRow.childCount - 1)).requestFocus()
        }
        paintPills()
    }

    private fun paintPills() {
        val dm = resources.displayMetrics.density
        val labels = pillLabels ?: return
        for (i in labels.indices) {
            val v = pillRow.getChildAt(i) as? TextView ?: continue
            val isOther = i == labels.lastIndex && !(labels.size == 1)
            val on = if (isOther) pillActive < 0 else (i == pillActive || (pillFallback && i == 0))
            val focused = v.isFocused
            v.text = if (on && !isOther) "\u2713  ${labels[i]}" else labels[i]
            v.setTextColor(if (on) 0xFF141414.toInt() else Color.WHITE)
            (v.background as GradientDrawable).apply {
                setColor(if (on) Color.WHITE else if (focused) 0xE6444444.toInt() else 0xB3262626.toInt())
                if (focused) setStroke((3 * dm).toInt(), if (on) 0xFF8A8A8A.toInt() else Color.WHITE) else setStroke(0, 0)
            }
            v.animate().scaleX(if (focused) 1.08f else 1f).scaleY(if (focused) 1.08f else 1f).setDuration(160).start()
        }
    }

    private fun applyPill(i: Int) {
        val p = player ?: return
        val pill = pills.getOrNull(i) ?: return
        try {
            val b = p.trackSelectionParameters.buildUpon()
            pillAudioRefs.getOrNull(pill.audio)?.let { (g, t) ->
                b.setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, t))
                Langs.code(g.getTrackFormat(t).language)?.let { b.setPreferredAudioLanguage(it) }
            }
            val sub = pillSubRefs.getOrNull(pill.sub)
            if (sub == null) {
                // "No subtitles" the way Media3's own Off works: drop any chosen text track but keep forced
                // ones (foreign-dialogue subs) on, instead of disabling every text track.
                b.clearOverridesOfType(C.TRACK_TYPE_TEXT)
                b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                b.setIgnoredTextSelectionFlags(C.SELECTION_FLAG_FORCED.inv())
            } else {
                b.setIgnoredTextSelectionFlags(0)
                b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                b.setOverrideForType(TrackSelectionOverride(sub.first.mediaTrackGroup, sub.second))
                Langs.code(sub.first.getTrackFormat(sub.second).language)?.let { b.setPreferredTextLanguage(it) }
            }
            p.trackSelectionParameters = b.build()
        } catch (_: Exception) {
        }
        pillActive = i
        paintPills()
    }

    private fun trackDialog(d: Dialog) {
        openDialogs++
        main.removeCallbacks(hideControlsRun)
        d.setOnDismissListener {
            openDialogs = (openDialogs - 1).coerceAtLeast(0)
            if (openDialogs == 0 && !isDestroyed && !finishing) showControls()
        }
        d.show()
    }

    /** "Other..." / gear: Media3's own track-selection dialogs (audio, subtitles). */
    private fun openOtherTracks() {
        val p = player ?: return
        val hasA = p.currentTracks.groups.any { it.type == C.TRACK_TYPE_AUDIO }
        val hasT = p.currentTracks.groups.any { it.type == C.TRACK_TYPE_TEXT }
        fun tracks(type: Int, title: String) {
            val b = TrackSelectionDialogBuilder(this, title, p, type).setAllowAdaptiveSelections(false)
            if (type == C.TRACK_TYPE_TEXT) b.setShowDisableOption(true)
            trackDialog(b.build())
        }
        when {
            hasA && hasT -> trackDialog(
                AlertDialog.Builder(this).setTitle("Audio & Subtitles").setItems(arrayOf("Audio", "Subtitles")) { _, w ->
                    if (w == 0) tracks(C.TRACK_TYPE_AUDIO, "Audio") else tracks(C.TRACK_TYPE_TEXT, "Subtitles")
                }.create(),
            )
            hasA -> tracks(C.TRACK_TYPE_AUDIO, "Audio")
            hasT -> tracks(C.TRACK_TYPE_TEXT, "Subtitles")
        }
    }

    private fun focusedIndex(row: LinearLayout): Int? = (0 until row.childCount).firstOrNull { row.getChildAt(it).isFocused }

    /** Moves focus to the next visible child in [dir]; stays put at the ends. */
    private fun stepFocus(row: LinearLayout, from: Int, dir: Int) {
        var i = from + dir
        while (i in 0 until row.childCount) {
            val c = row.getChildAt(i)
            if (c.visibility == View.VISIBLE && c.isFocusable) { c.requestFocus(); return }
            i += dir
        }
    }

    private fun activateTop(v: View) {
        when (v) {
            backBtn -> finishPlayback()
            replayBtn -> player?.let { it.seekTo(0); it.play() }
            nextTopBtn -> playNext()
        }
    }

    /**
     * Focus rows: top icons / main row (play + bar) / pills + gear. Handles Left/Right inside the top and pill
     * rows, and Up/Down between the three rows. Left/Right in the main row seek (see [handleMainKey]).
     */
    private fun handleRowKey(event: KeyEvent): Boolean {
        val code = event.keyCode
        val isDpad = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT ||
            code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN ||
            code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
        if (!isDpad || !controlsShown) return false
        val down = event.action == KeyEvent.ACTION_DOWN
        val first = event.repeatCount == 0
        val top = focusedIndex(topRow)
        val pill = focusedIndex(pillRow)
        if (top != null) {
            if (down) {
                when (code) {
                    KeyEvent.KEYCODE_DPAD_LEFT -> stepFocus(topRow, top, -1)
                    KeyEvent.KEYCODE_DPAD_RIGHT -> stepFocus(topRow, top, 1)
                    KeyEvent.KEYCODE_DPAD_DOWN -> if (first) playBtn.requestFocus()
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> if (first) activateTop(topRow.getChildAt(top))
                }
                if (controlsShown) showControls()
            }
            return true
        }
        if (pill != null) {
            if (down) {
                var opened = false
                when (code) {
                    KeyEvent.KEYCODE_DPAD_LEFT -> stepFocus(pillRow, pill, -1)
                    KeyEvent.KEYCODE_DPAD_RIGHT -> stepFocus(pillRow, pill, 1)
                    KeyEvent.KEYCODE_DPAD_UP -> if (first) playBtn.requestFocus()
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> if (first) {
                        if (pill < pills.size) applyPill(pill) else { opened = true; openOtherTracks() }
                    }
                }
                if (!opened) showControls() // keep the controls up while navigating
            }
            return true
        }
        // Main row (or nothing focused): Up goes to the top icons, Down to the pills.
        if (code == KeyEvent.KEYCODE_DPAD_UP) {
            if (down) {
                if (first) (0 until topRow.childCount).map { topRow.getChildAt(it) }.firstOrNull { it.visibility == View.VISIBLE }?.requestFocus()
                showControls()
            }
            return true
        }
        if (code == KeyEvent.KEYCODE_DPAD_DOWN && scrubDir == 0) {
            if (down) {
                if (first && pillRow.childCount > 0) {
                    pillRow.getChildAt(pillActive.takeIf { it in 0 until pillRow.childCount } ?: 0).requestFocus()
                }
                showControls()
            }
            return true
        }
        return false
    }

    /** Play / pause, 10 s seeks and "any key shows the controls" for the main row (and hidden controls). */
    private fun handleMainKey(p: ExoPlayer, event: KeyEvent): Boolean {
        val code = event.keyCode
        val down = event.action == KeyEvent.ACTION_DOWN
        val first = event.repeatCount == 0
        when (code) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (down) {
                    if (first) {
                        when (code) {
                            KeyEvent.KEYCODE_MEDIA_PLAY -> p.play()
                            KeyEvent.KEYCODE_MEDIA_PAUSE -> p.pause()
                            else -> togglePlay(p)
                        }
                        updatePlayIcon()
                    }
                    showControls()
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                if (down) {
                    if (first) {
                        if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_MEDIA_REWIND) {
                            p.seekTo((p.currentPosition - SEEK_MS).coerceAtLeast(0))
                        } else {
                            val dur = p.duration
                            val target = p.currentPosition + SEEK_MS
                            p.seekTo(if (dur != C.TIME_UNSET) target.coerceAtMost(dur) else target)
                        }
                    }
                    showControls()
                    if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                        if (!timeBar.isFocused) timeBar.requestFocus() // shows the white thumb while seeking
                    }
                    updateControls()
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (down) showControls()
                return true
            }
        }
        return false
    }

    // ---- Credits: Next Episode / Watch Credits ----

    private fun pill(label: String, bg: Int, fg: Int) = TextView(this).apply {
        text = label
        textSize = 22f
        setTextColor(fg)
        setPadding(44, 22, 44, 22)
        background = GradientDrawable().apply { cornerRadius = 10f; setColor(bg) }
    }

    private fun paintCreditsFocus() {
        // The focused choice is lifted and outlined, like the web UI's focus glow.
        listOf(nextBtn, creditsBtn).forEachIndexed { idx, v ->
            val on = idx == creditsFocus
            (v.background as GradientDrawable).setColor(if (on) Color.WHITE else 0xB3262626.toInt())
            v.setTextColor(if (on) 0xFF141414.toInt() else Color.WHITE)
            v.animate().scaleX(if (on) 1.08f else 1f).scaleY(if (on) 1.08f else 1f).setDuration(160).start()
        }
    }

    private fun showCredits(autoAdvance: Boolean) {
        creditsShown = true
        creditsFocus = 0
        hideControls(true)
        nextBtn.text = "\u25B6  Next Episode"
        creditsBar.visibility = View.VISIBLE
        paintCreditsFocus()
        if (autoAdvance) {
            creditsLeft = CREDITS_COUNTDOWN_S
            main.post(creditsTick)
        }
    }

    private fun hideCredits(dismissed: Boolean) {
        main.removeCallbacks(creditsTick)
        if (dismissed) creditsDismissed = true
        if (!creditsShown) return
        creditsShown = false
        creditsBar.visibility = View.GONE
    }

    private fun playNext() {
        val next = info?.nextEpisodeId ?: return
        hideCredits(false)
        // Skipping the credits counts as finished: report the end, or a credits chapter before Jellyfin's 90%
        // mark would leave this episode half-watched and back on Continue Watching.
        reportStopped(player?.duration?.takeIf { it > 0 })
        loadItem(next)
    }

    private val listener = object : Player.Listener {
        override fun onTracksChanged(tracks: Tracks) {
            refreshPills()
        }

        override fun onPlaybackStateChanged(state: Int) {
            when (state) {
                Player.STATE_READY -> {
                    statusText.visibility = View.GONE
                    if (!startReported) {
                        startReported = true
                        sessionOpen = true
                        report("Playing")
                        main.removeCallbacks(progressTick)
                        main.postDelayed(progressTick, PROGRESS_MS)
                    }
                }
                Player.STATE_ENDED -> onEnded()
                else -> {}
            }
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            updatePlayIcon()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            updatePlayIcon()
            if (startReported) report("Progress")
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK && startReported) report("Progress")
        }

        override fun onPlayerError(error: PlaybackException) {
            reportStopped(null)
            showError(describePlayerError(error))
        }
    }

    private fun describePlayerError(e: PlaybackException): String {
        val i = info
        val codecs = if (i != null) "Video ${i.videoCodec}, audio ${i.audioCodec}, container ${i.container}." else ""
        return when (e.errorCode) {
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
                "This device can't decode this file (unsupported codec). $codecs"
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED ->
                "This file's container isn't supported. $codecs"
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
                "Couldn't load the video stream from the media server (${e.errorCodeName})."
            else -> "Playback failed (${e.errorCodeName}). $codecs"
        }.trim()
    }

    // ---- End of episode ----

    private fun onEnded() {
        val i = info ?: return
        hideCredits(true)
        val dur = player?.duration?.takeIf { it > 0 }
        reportStopped(dur)
        if (i.nextEpisodeId == null) {
            finishPlayback()
            return
        }
        countdownLeft = NEXT_COUNTDOWN_S
        nextOverlay.visibility = View.VISIBLE
        main.post(countdownTick)
    }

    // ---- Error UI ----

    private fun showError(message: String) {
        if (errorBox != null) return
        statusText.visibility = View.GONE
        hideControls(true)
        val msg = TextView(this).apply {
            text = message
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER
        }
        val btn = Button(this).apply {
            text = "Back"
            isFocusable = true
            setOnClickListener { finishPlayback() }
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(96, 48, 96, 48)
            setBackgroundColor(0xEE000000.toInt())
            isClickable = true
            addView(msg, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(btn, LinearLayout.LayoutParams(360, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 48 })
        }
        errorBox = box
        root.addView(box, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        btn.requestFocus()
    }

    private fun removeError() {
        errorBox?.let { root.removeView(it) }
        errorBox = null
    }

    // ---- Keys ----

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if (creditsShown && errorBox == null) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                when (code) {
                    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                        creditsFocus = if (code == KeyEvent.KEYCODE_DPAD_LEFT) 1 else 0
                        if (creditsFocus == 1) { main.removeCallbacks(creditsTick); nextBtn.text = "\u25B6  Next Episode" }
                        paintCreditsFocus()
                        return true
                    }
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                        if (event.repeatCount == 0) { if (creditsFocus == 0) playNext() else hideCredits(true) }
                        return true
                    }
                    KeyEvent.KEYCODE_BACK -> return true
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> return true
                }
            } else if (event.action == KeyEvent.ACTION_UP && code == KeyEvent.KEYCODE_BACK) {
                hideCredits(true) // Back = keep watching the credits
                return true
            }
            // Swallow the release too, or the player's own controls pop up over the buttons.
            when (code) {
                KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> return true
            }
        }
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) {
                if (controlsShown && nextOverlay.visibility != View.VISIBLE) {
                    hideControls() // first Back only hides the controls
                } else {
                    // Back during the next-episode countdown cancels the auto-advance and leaves the player.
                    main.removeCallbacks(countdownTick)
                    nextOverlay.visibility = View.GONE
                    finishPlayback()
                }
            }
            return true
        }
        if (errorBox != null) return super.dispatchKeyEvent(event)
        val p = player
        if (p != null && nextOverlay.visibility != View.VISIBLE && handleRowKey(event)) return true
        // Hold Left/Right to fast-forward / rewind: the position ramps up the longer the key is
        // held (Scrub), seeks are throttled, and the final position is committed on release.
        if (p != null && nextOverlay.visibility != View.VISIBLE &&
            (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT)
        ) {
            val dir = if (code == KeyEvent.KEYCODE_DPAD_RIGHT) 1 else -1
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount > 0) {
                val now = SystemClock.uptimeMillis()
                if (scrubDir != dir) {
                    scrubDir = dir
                    scrubPos = p.currentPosition
                    scrubStartAt = now
                    scrubLastAt = now
                    scrubLastSeekAt = 0L
                }
                val dur = if (p.duration == C.TIME_UNSET) 0L else p.duration
                scrubPos = Scrub.advance(scrubPos, dir, now - scrubStartAt, now - scrubLastAt, dur)
                scrubLastAt = now
                if (now - scrubLastSeekAt >= 250) { p.seekTo(scrubPos); scrubLastSeekAt = now }
                showControls()
                return true
            }
            if (event.action == KeyEvent.ACTION_UP && scrubDir != 0) {
                p.seekTo(scrubPos)
                scrubDir = 0
                if (controlsShown) timeBar.requestFocus()
                updateControls()
                return true
            }
        }
        if (p != null && nextOverlay.visibility != View.VISIBLE && handleMainKey(p, event)) return true
        return super.dispatchKeyEvent(event)
    }

    // ---- Jellyfin reporting ----

    private fun body(i: Info, posMs: Long, paused: Boolean): String = JSONObject().apply {
        put("ItemId", i.itemId)
        put("MediaSourceId", i.mediaSourceId)
        put("PlaySessionId", i.playSessionId)
        put("PositionTicks", posMs * 10_000L)
        put("IsPaused", paused)
        put("CanSeek", true)
        put("PlayMethod", "DirectPlay")
    }.toString()

    private fun report(kind: String) {
        val i = info ?: return
        if (i.live) return
        val p = player ?: return
        if (!sessionOpen) return
        val payload = body(i, p.currentPosition.coerceAtLeast(0), !p.isPlaying)
        val path = if (kind == "Playing") "/Sessions/Playing" else "/Sessions/Playing/Progress"
        reporter.execute {
            try {
                Net.postJellyfin(i.base, path, i.token, payload)
            } catch (_: Exception) {
            }
        }
    }

    /** Sends Stopped once per open session. posOverride is used when the player is already at the end. */
    private fun reportStopped(posOverride: Long?) {
        main.removeCallbacks(progressTick)
        val i = info ?: return
        if (i.live) {
            if (i.liveStreamId.isNotEmpty()) { val ls = i.liveStreamId; info = null; reporter.execute { Net.stopLive(ls, profileId) } }
            return
        }
        if (!sessionOpen) return
        sessionOpen = false
        startReported = false
        val pos = posOverride ?: player?.currentPosition?.coerceAtLeast(0) ?: 0L
        val payload = body(i, pos, true)
        reporter.execute {
            try {
                Net.postJellyfin(i.base, "/Sessions/Playing/Stopped", i.token, payload)
            } catch (_: Exception) {
            }
        }
    }

    // ---- Lifecycle ----

    private fun finishPlayback() {
        if (finishing) return
        finishing = true
        reportStopped(null)
        player?.stop()
        finish()
    }

    override fun onStop() {
        super.onStop()
        // Leaving the screen (Home, power) ends playback so Jellyfin gets its final position.
        if (!finishing) finishPlayback()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        reportStopped(null)
        loadGen++
        player?.let {
            it.removeListener(listener)
            playerView.player = null
            it.release()
        }
        player = null
        io.shutdown()
        probeExecutor.shutdown()
        reporter.shutdown() // queued reports still run
        super.onDestroy()
    }
}
