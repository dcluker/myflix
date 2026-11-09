package dev.theprivatehome.myflix

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class PairClientTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient()

    @Before fun up() { server = MockWebServer().also { it.start() } }
    @After fun down() { server.shutdown() }

    private fun base() = server.url("/").toString().trimEnd('/')
    private fun client(debugHost: String = "localhost", suffix: String = ".example.test") =
        PairClient(http, base(), suffix, debugHost, "https://my.example.test", "https://jf.example.test")

    private fun ok(extra: String = "") = MockResponse().setResponseCode(200).setBody(
        """{"clientId":"cid","clientSecret":"sec","name":"Sam","myflixBase":"https://my.example.test","jellyfinBase":"https://jf.example.test"$extra}""")

    @Test fun successSendsFormattedCodeAndLabel() {
        server.enqueue(ok())
        val r = client().pair("k7qd m3xp", "Living room TV")
        assertTrue(r is PairResult.Success)
        val c = (r as PairResult.Success).creds
        assertEquals("cid", c.clientId); assertEquals("sec", c.clientSecret); assertEquals("Sam", c.name)
        val req = server.takeRequest()
        assertEquals("POST", req.method); assertEquals("/pair", req.path)
        val b = JSONObject(req.body.readUtf8())
        assertEquals("K7QD-M3XP", b.getString("code")); assertEquals("Living room TV", b.getString("deviceLabel"))
        assertNull("no auth headers on the pairing call", req.getHeader("CF-Access-Client-Secret"))
    }

    @Test fun statusMapping() {
        fun code(n: Int): PairResult {
            server.enqueue(MockResponse().setResponseCode(n).setBody("{}"))
            return client().pair("K7QDM3XP", "x")
        }
        assertSame(PairResult.Malformed, code(400))
        assertSame(PairResult.WrongCode, code(404))
        assertSame(PairResult.RateLimited, code(429))
        assertEquals(PairResult.ServerError(502), code(502))
    }

    @Test fun shortCodeNeverHitsNetwork() {
        assertSame(PairResult.Malformed, client().pair("K7Q", "x"))
        assertEquals(0, server.requestCount)
    }

    @Test fun offlineIsReported() {
        val c = client()
        server.shutdown()
        assertSame(PairResult.Offline, c.pair("K7QDM3XP", "x"))
    }

    @Test fun untrustedBasesAreRejected() {
        server.enqueue(MockResponse().setBody("""{"clientId":"a","clientSecret":"b","myflixBase":"https://evil.com","jellyfinBase":"https://jf.example.test"}"""))
        assertSame(PairResult.BadResponse, client().pair("K7QDM3XP", "x"))
        server.enqueue(MockResponse().setBody("""{"clientId":"a","clientSecret":"b","myflixBase":"http://my.example.test","jellyfinBase":"https://jf.example.test"}"""))
        assertSame(PairResult.BadResponse, client().pair("K7QDM3XP", "x"))
        server.enqueue(MockResponse().setBody("not json"))
        assertSame(PairResult.BadResponse, client().pair("K7QDM3XP", "x"))
    }

    @Test fun missingBasesFallBackToConfiguredDefaults() {
        server.enqueue(MockResponse().setBody("""{"clientId":"a","clientSecret":"b"}"""))
        val r = client().pair("K7QDM3XP", "x") as PairResult.Success
        assertEquals("https://my.example.test", r.creds.myflixBase)
        assertEquals("https://jf.example.test", r.creds.jellyfinBase)
    }

    @Test fun updateDownloadVerifiesDigest() {
        val bytes = ByteArray(300_000) { (it % 251).toByte() }
        val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val buf = okio.Buffer().write(bytes)
        server.enqueue(MockResponse().setBody(buf))
        val url = server.url("/MyFlix.apk").toString()
        val f = File.createTempFile("upd", ".apk")
        Updater.download(http, UpdateInfo(6, "2.2.0", hex, url, 25), f, ".example.test", "localhost")
        assertEquals(bytes.size.toLong(), f.length())

        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        try {
            Updater.download(http, UpdateInfo(6, "2.2.0", "00".repeat(32), url, 25), f, ".example.test", "localhost")
            fail("expected checksum failure")
        } catch (e: Updater.BadUpdate) {
            assertFalse("bad file removed", f.exists())
        }
    }

    @Test fun updateRefusesOffDomainApk() {
        val f = File.createTempFile("upd", ".apk")
        try {
            Updater.download(http, UpdateInfo(6, "2.2.0", "00", "https://evil.com/MyFlix.apk", 25), f, ".example.test", "")
            fail()
        } catch (e: Updater.BadUpdate) { }
        assertEquals(0, server.requestCount)
    }

    @Test fun updateCheckOnlyReturnsNewer() {
        server.enqueue(MockResponse().setBody("""{"versionCode":6,"versionName":"2.2.0","sha256":"ab","apk":"x","minSdk":25}"""))
        assertNotNull(Updater.check(http, base(), 5, 30))
        server.enqueue(MockResponse().setBody("""{"versionCode":6,"versionName":"2.2.0","sha256":"ab","apk":"x","minSdk":25}"""))
        assertNull(Updater.check(http, base(), 6, 30))
        server.enqueue(MockResponse().setResponseCode(500))
        assertNull(Updater.check(http, base(), 5, 30))
    }
}
