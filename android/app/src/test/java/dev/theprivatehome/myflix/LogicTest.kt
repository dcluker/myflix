package dev.theprivatehome.myflix

import org.junit.Assert.*
import org.junit.Test

class LogicTest {
    private val suffix = ".example.test"

    @Test fun cfHeadersOnlyForHttpsDomainHosts() {
        assertTrue(Hosts.cfEligible("https://jellyfin.example.test/Videos/1/stream?x=1", suffix))
        assertTrue(Hosts.cfEligible("https://a.b.example.test", suffix))
        assertFalse("cleartext LAN", Hosts.cfEligible("http://192.168.0.10:8096/Videos/1", suffix))
        assertFalse("cleartext on our own domain", Hosts.cfEligible("http://jellyfin.example.test/", suffix))
        assertFalse("bare domain", Hosts.cfEligible("https://example.test/", suffix))
        assertFalse("lookalike", Hosts.cfEligible("https://evilexample.test/", suffix))
        assertFalse("suffix as subdomain label", Hosts.cfEligible("https://example.test.evil.com/", suffix))
        assertFalse("userinfo trick", Hosts.cfEligible("https://jellyfin.example.test@evil.com/", suffix))
        assertFalse(Hosts.cfEligible("not a url", suffix))
        assertFalse(Hosts.cfEligible("", suffix))
    }

    @Test fun debugHostIsOptIn() {
        assertFalse(Hosts.cfEligible("http://10.0.2.2:8765/pair", suffix))
        assertTrue(Hosts.cfEligible("http://10.0.2.2:8765/pair", suffix, "10.0.2.2"))
        assertFalse(Hosts.cfEligible("http://10.0.2.3/pair", suffix, "10.0.2.2"))
    }

    @Test fun lanBaseMustBePrivate() {
        assertTrue(Hosts.isPrivateLanBase("http://192.168.0.10:8096"))
        assertTrue(Hosts.isPrivateLanBase("http://10.1.2.3:8096"))
        assertTrue(Hosts.isPrivateLanBase("http://172.20.0.5"))
        assertFalse(Hosts.isPrivateLanBase("http://172.32.0.5"))
        assertFalse(Hosts.isPrivateLanBase("http://8.8.8.8:8096"))
        assertFalse(Hosts.isPrivateLanBase("http://jellyfin.local"))
    }

    @Test fun codeNormalizing() {
        assertEquals("K7QDM3XP", PairCode.normalize("k7qd-m3xp"))
        assertEquals("K7QDM3XP", PairCode.normalize(" K7QD M3XP "))
        assertNull(PairCode.normalize("K7QD-M3X"))
        assertNull(PairCode.normalize("K7QD-M3XPZ"))
        assertEquals("K7QD-M3XP", PairCode.format("K7QDM3XP"))
        assertEquals("K7Q", PairCode.format("K7Q"))
    }

    @Test fun lanOnlyWhenServerIdMatches() {
        val lan = "http://192.168.0.10:8096"
        val pub = "https://jellyfin.example.test"
        assertEquals(lan, Endpoints.choose(lan, pub, "", "abc", "abc"))
        assertEquals("other device answered", pub, Endpoints.choose(lan, pub, "", "abc", "zzz"))
        assertEquals("no answer", pub, Endpoints.choose(lan, pub, "", "abc", null))
        assertEquals("server gave no id: never LAN", pub, Endpoints.choose(lan, pub, "", null, "abc"))
        assertEquals("empty ids never match", pub, Endpoints.choose(lan, pub, "", "", ""))
        assertEquals("non-private lanBase refused", pub, Endpoints.choose("http://8.8.8.8:8096", pub, "", "abc", "abc"))
        assertEquals("old server", "http://old:8096", Endpoints.choose(null, null, "http://old:8096/", null, null))
    }

    @Test fun rebaseKeepsPathAndQuery() {
        val u = "http://192.168.0.10:8096/Videos/X/stream?static=true&mediaSourceId=M&api_key=T"
        assertEquals("https://j.example.test/Videos/X/stream?static=true&mediaSourceId=M&api_key=T",
            Endpoints.rebase(u, "https://j.example.test/"))
    }

    @Test fun updateParsingAndOrdering() {
        val i = Updater.parse("""{"versionCode":6,"versionName":"2.2.0","sha256":"AB","apk":"https://tv.example.test/MyFlix.apk","minSdk":25}""")!!
        assertTrue(Updater.isNewer(i, 5, 28))
        assertFalse(Updater.isNewer(i, 6, 28))
        assertFalse("minSdk too high", Updater.isNewer(i, 5, 24))
        assertNull(Updater.parse("garbage"))
        assertTrue(Versions.sameDigest("ab ", "AB"))
    }

    @Test
    fun scrubSpeedRampsUpWhileHeld() {
        assertEquals(60, Scrub.speed(0))
        assertEquals(120, Scrub.speed(2000))
        assertEquals(240, Scrub.speed(4000))
        assertEquals(360, Scrub.speed(9000))
    }

    @Test
    fun scrubAdvanceStaysInsideTheMedia() {
        assertEquals(70_000L, Scrub.advance(10_000, 1, 0, 1000, 600_000)) // 60x for one second
        assertEquals(0L, Scrub.advance(5_000, -1, 0, 1000, 600_000))      // clamps at the start
        assertEquals(599_000L, Scrub.advance(590_000, 1, 9000, 1000, 600_000)) // clamps near the end
        assertEquals(70_000L, Scrub.advance(10_000, 1, 0, 1000, 0)) // unknown duration
    }

    @Test
    fun languageNames() {
        assertEquals("English", Langs.name("en"))
        assertEquals("English", Langs.name("eng"))
        assertEquals("English", Langs.name("en-US"))
        assertEquals("Spanish", Langs.name("spa"))
        assertEquals("French", Langs.name("fre"))
        assertEquals("Japanese", Langs.name("jpn"))
        assertNull(Langs.name("und"))
        assertNull(Langs.name(null))
        assertNull(Langs.name(""))
        assertEquals("en", Langs.code("ENG"))
    }

    private fun a(lang: String?, label: String? = null) = TrackDesc(lang, label)
    private fun s(lang: String?, label: String? = null, forced: Boolean = false) = TrackDesc(lang, label, forced)

    @Test
    fun noPillsWhenNothingToChoose() {
        assertTrue(Pills.build(emptyList(), emptyList()).isEmpty())
        assertTrue(Pills.build(listOf(a("en")), emptyList()).isEmpty())
        assertTrue("forced-only subs are not a choice", Pills.build(listOf(a("en")), listOf(s("en", forced = true))).isEmpty())
    }

    @Test
    fun singleAudioWithSubtitles() {
        val p = Pills.build(listOf(a("eng")), listOf(s("eng")))
        assertEquals(listOf("English", "English + Subtitles"), p.map { it.label })
        assertEquals(listOf(Pill("English", 0, -1), Pill("English + Subtitles", 0, 0)), p)
    }

    @Test
    fun audioOnlyPillsWhenNoSubtitles() {
        val p = Pills.build(listOf(a("en"), a("es")), emptyList())
        assertEquals(listOf("English", "Spanish"), p.map { it.label })
        assertTrue(p.all { it.sub == -1 })
    }

    @Test
    fun foreignAudioNamesTheSubtitleLanguage() {
        val p = Pills.build(listOf(a("ja"), a("en")), listOf(s("en"), s("es")))
        assertEquals(
            listOf("Japanese", "Japanese + English Subtitles", "Japanese + Spanish Subtitles", "English", "English + Subtitles"),
            p.map { it.label },
        )
    }

    @Test
    fun missingLanguageFallsBackToLabelThenDefault() {
        assertEquals("Default", Pills.trackName(a(null), 0))
        assertEquals("Track 3", Pills.trackName(a("und"), 2))
        assertEquals("Director Cut", Pills.trackName(a(null, "Director Cut"), 1))
        val p = Pills.build(listOf(a(null), a(null)), emptyList())
        assertEquals(listOf("Default", "Track 2"), p.map { it.label })
    }

    @Test
    fun duplicateLanguagesAreToldApart() {
        assertEquals(listOf("English (Commentary)", "English (Main)"), Pills.audioNames(listOf(a("en", "Commentary"), a("en", "Main"))))
        assertEquals(listOf("English 1", "English 2"), Pills.audioNames(listOf(a("en"), a("eng"))))
    }

    @Test
    fun pillCountIsCapped() {
        val audios = (0 until 5).map { a(listOf("en", "es", "fr", "de", "it")[it]) }
        assertEquals(Pills.MAX, Pills.build(audios, listOf(s("en"))).size)
    }

    @Test
    fun activePillFollowsTheSelection() {
        val subs = listOf(s("en"), s("en", forced = true))
        val p = Pills.build(listOf(a("en"), a("es")), subs)
        // p: English, English + Subtitles, Spanish, Spanish + English Subtitles
        assertEquals(0, Pills.active(p, subs, 0, -1))
        assertEquals(1, Pills.active(p, subs, 0, 0))
        assertEquals("forced-only subtitle counts as off", 0, Pills.active(p, subs, 0, 1))
        assertEquals(2, Pills.active(p, subs, 1, -1))
        assertEquals(3, Pills.active(p, subs, 1, 0))
        assertEquals("nothing selected", -1, Pills.active(p, subs, -1, -1))
    }

    @Test
    fun clockFormatting() {
        assertEquals("02:54", TimeFmt.clock(174_000))
        assertEquals("00:00", TimeFmt.clock(-5))
        assertEquals("59:59", TimeFmt.clock(3_599_999))
        assertEquals("1:02:54", TimeFmt.clock(3_774_000))
        assertEquals("-18:49", TimeFmt.remaining(60_000, 1_189_000))
        assertEquals("-00:00", TimeFmt.remaining(5_000, 0))
        assertEquals("-00:00", TimeFmt.remaining(9_000, 5_000))
    }

    @Test
    fun episodeLines() {
        assertEquals("S1: E1 \"Pilot\"", Titles.episodeLine(1, 1, "Pilot"))
        assertEquals("S2: E10", Titles.episodeLine(2, 10, " "))
        assertEquals("Pilot", Titles.episodeLine(null, 1, "Pilot"))
        assertEquals("", Titles.episodeLine(null, null, ""))
    }
}
