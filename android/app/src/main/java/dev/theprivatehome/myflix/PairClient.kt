package dev.theprivatehome.myflix

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

sealed class PairResult {
    data class Success(val creds: Credentials) : PairResult()
    object Malformed : PairResult()      // 400
    object WrongCode : PairResult()      // 404 (unknown / expired / used)
    object RateLimited : PairResult()    // 429
    object Offline : PairResult()        // no connection / timeout
    data class ServerError(val http: Int) : PairResult()
    object BadResponse : PairResult()    // 200 but unusable / untrusted body
}

class PairClient(
    private val http: OkHttpClient,
    private val tvBase: String,
    private val hostSuffix: String,
    private val debugHost: String,
    private val fallbackMyflix: String,
    private val fallbackJellyfin: String,
) {
    private val json = "application/json".toMediaType()

    fun pair(rawCode: String, label: String): PairResult {
        val code = PairCode.normalize(rawCode) ?: return PairResult.Malformed
        val body = JSONObject().put("code", PairCode.format(code)).put("deviceLabel", label.trim().take(64)).toString()
        val req = Request.Builder()
            .url(tvBase.trimEnd('/') + "/pair")
            .header("Accept", "application/json")
            .post(body.toRequestBody(json))
            .build()
        try {
            http.newCall(req).execute().use { r ->
                val text = r.body?.string().orEmpty()
                return when (r.code) {
                    200 -> parse(text)
                    400 -> PairResult.Malformed
                    404 -> PairResult.WrongCode
                    429 -> PairResult.RateLimited
                    else -> PairResult.ServerError(r.code)
                }
            }
        } catch (_: IOException) {
            return PairResult.Offline
        }
    }

    private fun parse(text: String): PairResult = try {
        val j = JSONObject(text)
        val id = j.getString("clientId")
        val secret = j.getString("clientSecret")
        val my = j.optString("myflixBase").ifEmpty { fallbackMyflix }
        val jf = j.optString("jellyfinBase").ifEmpty { fallbackJellyfin }
        // The credentials only ever go to hosts we trust: https under the configured domain.
        if (id.isEmpty() || secret.isEmpty() ||
            !Hosts.cfEligible(my, hostSuffix, debugHost) || !Hosts.cfEligible(jf, hostSuffix, debugHost)
        ) PairResult.BadResponse
        else PairResult.Success(Credentials(id, secret, j.optString("name"), my.trimEnd('/'), jf.trimEnd('/')))
    } catch (_: Exception) {
        PairResult.BadResponse
    }
}
