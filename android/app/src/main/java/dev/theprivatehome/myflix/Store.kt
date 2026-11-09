package dev.theprivatehome.myflix

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

data class Credentials(
    val clientId: String,
    val clientSecret: String,
    val name: String,
    val myflixBase: String,
    val jellyfinBase: String,
)

/**
 * Pairing credentials, kept in EncryptedSharedPreferences (Android Keystore master key).
 * If the Keystore is unusable on a device (seen on some TV firmware) it falls back to the app's
 * private, non-backed-up storage rather than leaving the box unable to pair.
 */
class Store(private val ctx: Context) {
    private val secure: SharedPreferences by lazy { openSecure() }
    private val plain: SharedPreferences by lazy { ctx.getSharedPreferences("myflix_install", Context.MODE_PRIVATE) }

    private fun openSecure(): SharedPreferences {
        fun open(): SharedPreferences {
            val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(
                ctx, "myflix_creds", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
        return try {
            open()
        } catch (e: Exception) {
            Log.w("MyFlix", "secure storage unavailable (${e.javaClass.simpleName}); resetting")
            try {
                ctx.deleteSharedPreferences("myflix_creds")
                open()
            } catch (e2: Exception) {
                Log.w("MyFlix", "secure storage still unavailable; using app-private storage")
                ctx.getSharedPreferences("myflix_creds_fallback", Context.MODE_PRIVATE)
            }
        }
    }

    /** Random per-install id, reported to Jellyfin as DeviceId. */
    val deviceId: String
        get() {
            plain.getString("deviceId", null)?.let { return it }
            val id = UUID.randomUUID().toString()
            plain.edit().putString("deviceId", id).apply()
            return id
        }

    fun load(): Credentials? {
        val id = secure.getString("clientId", null) ?: return null
        val sec = secure.getString("clientSecret", null) ?: return null
        return Credentials(
            id, sec,
            secure.getString("name", "") ?: "",
            secure.getString("myflixBase", "") ?: "",
            secure.getString("jellyfinBase", "") ?: "",
        )
    }

    fun save(c: Credentials) {
        secure.edit()
            .putString("clientId", c.clientId).putString("clientSecret", c.clientSecret)
            .putString("name", c.name).putString("myflixBase", c.myflixBase)
            .putString("jellyfinBase", c.jellyfinBase)
            .commit()
    }

    fun clear() {
        secure.edit().clear().commit()
    }

    /** LAN address + secret for talking to MyFlix with no internet (fetched while online). */
    var lanBase: String
        get() = secure.getString("lanBase", "") ?: ""
        set(v) { secure.edit().putString("lanBase", v).commit() }
    var lanSecret: String
        get() = secure.getString("lanSecret", "") ?: ""
        set(v) { secure.edit().putString("lanSecret", v).commit() }

    var deviceLabel: String
        get() = plain.getString("label", null) ?: ""
        set(v) { plain.edit().putString("label", v).apply() }

    var lastUpdateCheck: Long
        get() = plain.getLong("lastUpdateCheck", 0L)
        set(v) { plain.edit().putLong("lastUpdateCheck", v).apply() }
}
