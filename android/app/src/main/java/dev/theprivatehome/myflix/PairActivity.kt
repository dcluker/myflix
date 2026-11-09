package dev.theprivatehome.myflix

import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.Executors

/** First-run pairing: type the 8-character code from the invite with the remote's D-pad. */
class PairActivity : AppCompatActivity() {

    companion object {
        private const val KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        private const val COLS = 9
        private const val MAX = 8

        fun start(ctx: Context) {
            ctx.startActivity(Intent(ctx, PairActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private val io = Executors.newSingleThreadExecutor()
    private val code = StringBuilder()
    private var label = ""
    private var busy = false

    private lateinit var codeView: TextView
    private lateinit var status: TextView
    private lateinit var nameBtn: TextView
    private lateinit var connectBtn: TextView

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun keyBg(): StateListDrawable {
        fun shape(c: Int) = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(c) }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(Color.WHITE))
            addState(intArrayOf(android.R.attr.state_pressed), shape(0xFFCCCCCC.toInt()))
            addState(intArrayOf(), shape(0xFF262626.toInt()))
        }
    }

    private fun keyText() = ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_pressed), intArrayOf()),
        intArrayOf(0xFF141414.toInt(), 0xFF141414.toInt(), Color.WHITE),
    )

    private fun key(text: String, wDp: Int, sp: Float = 20f, onClick: () -> Unit) = TextView(this).apply {
        this.text = text
        textSize = sp
        gravity = Gravity.CENTER
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(keyText())
        background = keyBg()
        isFocusable = true
        isFocusableInTouchMode = false
        isClickable = true
        contentDescription = text
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(wDp.let { if (it > 0) dp(it) else 0 }, dp(44), if (wDp > 0) 0f else 1f)
            .apply { setMargins(dp(3), dp(3), dp(3), dp(3)) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        label = Net.store.deviceLabel.ifEmpty { android.os.Build.MODEL }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.BLACK)
            setPadding(dp(32), dp(16), dp(32), dp(12))
        }
        fun text(t: String, sp: Float, c: Int = Color.WHITE) = TextView(this).apply {
            this.text = t; textSize = sp; setTextColor(c); gravity = Gravity.CENTER
        }
        col.addView(text("Connect MyFlix", 28f).apply { typeface = Typeface.DEFAULT_BOLD })
        col.addView(text("Enter the 8-character code from your invite.", 16f, 0xFFB3B3B3.toInt()))
        codeView = text("", 36f).apply {
            typeface = Typeface.MONOSPACE
            letterSpacing = 0.12f
            setPadding(0, dp(8), 0, dp(4))
        }
        col.addView(codeView)

        val rows = KEYS.chunked(COLS)
        for (r in rows) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
            for (ch in r) row.addView(key(ch.toString(), 52) { append(ch) })
            col.addView(row)
        }
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        actions.addView(key("Delete", 110, 16f) { backspace() })
        actions.addView(key("Clear", 90, 16f) { code.clear(); render(); setStatus("") })
        nameBtn = key("", 250, 14f) { editName() }
        actions.addView(nameBtn)
        connectBtn = key("Connect", 130, 18f) { connect() }
        actions.addView(connectBtn)
        col.addView(actions)

        status = text("", 16f, 0xFFFF8A80.toInt()).apply { setPadding(0, dp(8), 0, 0) }
        col.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(col)
        render()
        // Land on the first letter so the D-pad has somewhere to start.
        (col.getChildAt(3) as LinearLayout).getChildAt(0).requestFocus()
    }

    private fun render() {
        val slots = (0 until MAX).map { code.getOrElse(it) { '_' } }.joinToString("")
        codeView.text = slots.substring(0, 4) + "-" + slots.substring(4)
        nameBtn.text = "Name: $label"
    }

    private fun append(c: Char) {
        if (busy || code.length >= MAX) return
        code.append(c)
        setStatus("")
        render()
    }

    private fun backspace() {
        if (busy || code.isEmpty()) return
        code.deleteCharAt(code.length - 1)
        setStatus("")
        render()
    }

    private fun setStatus(msg: String, ok: Boolean = false) {
        status.setTextColor(if (ok) 0xFFB3B3B3.toInt() else 0xFFFF8A80.toInt())
        status.text = msg
    }

    private fun editName() {
        if (busy) return
        val et = EditText(this).apply { setText(label); setSelectAllOnFocus(true); setSingleLine() }
        AlertDialog.Builder(this)
            .setTitle("Name this device")
            .setView(et)
            .setPositiveButton("OK") { _, _ ->
                label = et.text.toString().trim().ifEmpty { android.os.Build.MODEL }
                Net.store.deviceLabel = label
                render()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun connect() {
        if (busy) return
        if (PairCode.normalize(code.toString()) == null) {
            setStatus("Enter all 8 characters of the code first.")
            return
        }
        busy = true
        connectBtn.alpha = 0.5f
        setStatus("Connecting...", ok = true)
        val c = code.toString()
        val l = label
        io.execute {
            val res = Net.pairClient().pair(c, l)
            runOnUiThread {
                busy = false
                connectBtn.alpha = 1f
                if (isDestroyed) return@runOnUiThread
                when (res) {
                    is PairResult.Success -> {
                        Net.setCreds(res.creds)
                        Net.store.deviceLabel = l
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    }
                    PairResult.Malformed -> setStatus("That doesn't look like a valid code. It has 8 letters and numbers, like K7QD-M3XP.")
                    PairResult.WrongCode -> setStatus("That code didn't work. Check it and try again. Codes expire after 3 days and work once, so you may need a new one.")
                    PairResult.RateLimited -> setStatus("Too many tries. Wait a minute, then try again.")
                    PairResult.Offline -> setStatus("Can't reach the server. Check this device's internet connection and try again.")
                    is PairResult.ServerError -> setStatus("The server had a problem (HTTP ${res.http}). Try again in a few minutes.")
                    PairResult.BadResponse -> setStatus("The server's reply wasn't recognized. Update the app or ask for help.")
                }
            }
        }
    }

    // Hardware keyboards (and `adb shell input text`) can type the code directly.
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val c = event.unicodeChar.toChar()
        if (event.isPrintingKey && (c.isLetterOrDigit()) && c.code < 128) {
            append(c.uppercaseChar())
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_DEL) {
            backspace()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

}
