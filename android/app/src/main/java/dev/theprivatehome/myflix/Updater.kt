package dev.theprivatehome.myflix

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val sha256: String,
    val apk: String,
    val minSdk: Int,
)

/** In-app update: version.json on the public pairing host, sha256-verified, installed via PackageInstaller. */
object Updater {
    fun parse(text: String): UpdateInfo? = try {
        val j = JSONObject(text)
        UpdateInfo(
            j.getInt("versionCode"), j.optString("versionName"),
            j.getString("sha256"), j.getString("apk"), j.optInt("minSdk", 1),
        )
    } catch (_: Exception) {
        null
    }

    fun isNewer(i: UpdateInfo, installedCode: Int, sdk: Int) = i.versionCode > installedCode && sdk >= i.minSdk

    /** Returns the available update, or null (up to date / unreachable / malformed). */
    fun check(http: OkHttpClient, tvBase: String, installedCode: Int, sdk: Int): UpdateInfo? = try {
        val req = Request.Builder().url(tvBase.trimEnd('/') + "/version.json").build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) null
            else parse(r.body?.string().orEmpty())?.takeIf { isNewer(it, installedCode, sdk) }
        }
    } catch (_: IOException) {
        null
    }

    class BadUpdate(msg: String) : Exception(msg)

    /**
     * Downloads [info].apk to [dest], refusing off-domain URLs, and deletes the file unless its
     * sha256 matches version.json. The package manager still enforces the signing certificate.
     */
    fun download(http: OkHttpClient, info: UpdateInfo, dest: File, hostSuffix: String, debugHost: String) {
        if (!Hosts.cfEligible(info.apk, hostSuffix, debugHost)) throw BadUpdate("update host not trusted")
        val md = MessageDigest.getInstance("SHA-256")
        http.newCall(Request.Builder().url(info.apk).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
            val body = r.body ?: throw IOException("empty")
            dest.outputStream().use { out ->
                body.byteStream().use { ins ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
        }
        val hex = md.digest().joinToString("") { "%02x".format(it) }
        if (!Versions.sameDigest(hex, info.sha256)) {
            dest.delete()
            throw BadUpdate("checksum mismatch")
        }
    }

    /** False when the user still has to allow installs from this app (settings screen is opened). */
    fun install(ctx: Context, apk: File): Boolean {
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
            ctx.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return false
        }
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            apk.inputStream().use { ins -> s.openWrite("MyFlix.apk", 0, apk.length()).use { out -> ins.copyTo(out); s.fsync(out) } }
            val cb = Intent(ctx, InstallReceiver::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            s.commit(PendingIntent.getBroadcast(ctx, id, cb, flags).intentSender)
        }
        return true
    }
}

class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1) == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
        }
    }
}
