package dev.theprivatehome.myflix

import java.net.URI

/** Pure helpers (no Android types) so they can be unit-tested on the JVM. */

object Hosts {
    private fun parts(url: String): Pair<String, String>? = try {
        val u = URI(url.trim())
        val h = u.host?.lowercase()
        if (u.scheme == null || h.isNullOrEmpty()) null else u.scheme.lowercase() to h
    } catch (_: Exception) {
        null
    }

    /**
     * True when Cloudflare Access headers may be attached to a request for [url]:
     * https only, and the host must sit under [suffix] (e.g. ".example.dev"). Never cleartext.
     * [debugHost] (debug builds only, empty otherwise) additionally admits one mock-server host.
     */
    fun cfEligible(url: String, suffix: String, debugHost: String = ""): Boolean {
        val (scheme, host) = parts(url) ?: return false
        if (debugHost.isNotEmpty() && host == debugHost.lowercase()) return true
        return scheme == "https" && suffix.startsWith(".") && host.endsWith(suffix.lowercase())
    }

    /** RFC1918 IPv4 literal host (the only thing the LAN probe may talk to). */
    fun isPrivateLanBase(base: String): Boolean {
        val (scheme, host) = parts(base) ?: return false
        if (scheme != "http" && scheme != "https") return false
        val o = host.split('.')
        if (o.size != 4) return false
        val n = o.map { it.toIntOrNull() ?: return false }
        if (n.any { it !in 0..255 }) return false
        return n[0] == 10 || (n[0] == 172 && n[1] in 16..31) || (n[0] == 192 && n[1] == 168)
    }
}

object PairCode {
    /** Strips spaces/dashes, upper-cases; returns 8 chars or null when it is not 8 letters/digits. */
    fun normalize(raw: String): String? {
        val s = raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
        return if (s.length == 8) s else null
    }

    /** "K7QDM3XP" -> "K7QD-M3XP" (partial input is formatted as far as it goes). */
    fun format(chars: String): String =
        if (chars.length <= 4) chars else chars.substring(0, 4) + "-" + chars.substring(4)
}

object Endpoints {
    /**
     * LAN base only when a server answered the probe AND its Id equals the serverId from playinfo
     * (so an unrelated device on the same private address never receives the Jellyfin token).
     * Without a serverId the LAN is never used.
     */
    fun choose(
        lanBase: String?,
        publicBase: String?,
        legacyBase: String?,
        serverId: String?,
        probedId: String?,
    ): String {
        if (!lanBase.isNullOrEmpty() && !serverId.isNullOrEmpty() && probedId == serverId &&
            Hosts.isPrivateLanBase(lanBase)
        ) return lanBase.trimEnd('/')
        val pub = publicBase?.takeIf { it.isNotEmpty() } ?: legacyBase.orEmpty()
        return pub.trimEnd('/')
    }

    /** Re-roots a (legacy absolute) stream URL's path+query on [base]. */
    fun rebase(streamUrl: String, base: String): String {
        val u = URI(streamUrl)
        val q = if (u.rawQuery != null) "?" + u.rawQuery else ""
        return base.trimEnd('/') + u.rawPath + q
    }
}

object Versions {
    /** Hex sha256 compare, case-insensitive. */
    fun sameDigest(a: String, b: String) = a.trim().equals(b.trim(), ignoreCase = true)
}

/** Hold-to-scrub on the D-pad: how fast playback position moves while Left/Right is held. */
object Scrub {
    /** Content seconds covered per real second after the key has been held [heldMs]. */
    fun speed(heldMs: Long): Int = when {
        heldMs < 1500 -> 60
        heldMs < 3000 -> 120
        heldMs < 5000 -> 240
        else -> 360
    }

    /** New position after [dtMs] of holding in direction [dir] (+1 / -1), kept inside the media. */
    fun advance(posMs: Long, dir: Int, heldMs: Long, dtMs: Long, durationMs: Long): Long {
        val next = posMs + dir * speed(heldMs) * dtMs
        val top = if (durationMs > 0) (durationMs - 1000).coerceAtLeast(0) else Long.MAX_VALUE
        return next.coerceIn(0L, top)
    }
}

/** Language codes -> readable names for the audio / subtitle pills. */
object Langs {
    private val specials = setOf("und", "mis", "zxx", "mul", "qaa", "")
    private val biblio = mapOf(
        "fre" to "fr", "ger" to "de", "chi" to "zh", "dut" to "nl", "gre" to "el", "cze" to "cs",
        "slo" to "sk", "rum" to "ro", "per" to "fa", "may" to "ms", "ice" to "is", "arm" to "hy",
        "geo" to "ka", "baq" to "eu", "bur" to "my", "alb" to "sq", "mac" to "mk", "mao" to "mi",
        "tib" to "bo", "wel" to "cy",
    )
    private val iso3: Map<String, String> by lazy {
        val m = HashMap<String, String>()
        for (l in java.util.Locale.getISOLanguages()) {
            try { m[java.util.Locale.forLanguageTag(l).isO3Language] = l } catch (_: Exception) {}
        }
        m.putAll(biblio)
        m
    }

    /** Normalised lowercase code ("eng", "en-US", "EN" -> "en"); null when missing or "und". */
    fun code(raw: String?): String? {
        val s = raw?.trim()?.lowercase()?.replace('_', '-')?.substringBefore('-').orEmpty()
        if (s in specials) return null
        return if (s.length == 3) iso3[s] ?: s else s
    }

    /** "English" for "en" / "eng"; null when the code is missing or unknown. */
    fun name(raw: String?): String? {
        val c = code(raw) ?: return null
        val n = try { java.util.Locale.forLanguageTag(c).getDisplayLanguage(java.util.Locale.ENGLISH) } catch (_: Exception) { "" }
        return n.takeIf { it.isNotBlank() && !it.equals(c, ignoreCase = true) }
    }
}

/** One audio or subtitle track as the player describes it. */
data class TrackDesc(val lang: String?, val label: String?, val forced: Boolean = false)

/** One pill: [audio] is an index into the audio list, [sub] an index into the subtitle list or -1 for subtitles off. */
data class Pill(val label: String, val audio: Int, val sub: Int)

/** Netflix-style audio + subtitle pills built from the tracks in the current media. */
object Pills {
    const val MAX = 6

    fun trackName(t: TrackDesc, index: Int): String =
        Langs.name(t.lang)
            ?: t.label?.trim()?.takeIf { it.isNotEmpty() }?.take(24)
            ?: if (index == 0) "Default" else "Track ${index + 1}"

    /** Names for the audio tracks; tracks sharing a language are told apart by label, else a number. */
    /** Label for the one fixed pill shown when a title has a single audio track and no subtitles. */
    fun fallbackLabel(audios: List<TrackDesc>): String {
        val a = audios.firstOrNull() ?: return "Audio"
        return Langs.name(a.lang)?.takeIf { it.isNotBlank() } ?: a.label?.takeIf { it.isNotBlank() } ?: "Default"
    }

    fun audioNames(audios: List<TrackDesc>): List<String> {
        val base = audios.mapIndexed { i, t -> trackName(t, i) }
        val seen = HashMap<String, Int>()
        return base.mapIndexed { i, b ->
            if (base.count { it == b } < 2) b else {
                val n = (seen[b] ?: 0) + 1
                seen[b] = n
                val lbl = audios[i].label?.trim().orEmpty().take(24)
                if (lbl.isNotEmpty() && !lbl.equals(b, ignoreCase = true)) "$b ($lbl)" else "$b $n"
            }
        }
    }

    fun build(audios: List<TrackDesc>, subs: List<TrackDesc>): List<Pill> {
        if (audios.isEmpty()) return emptyList()
        val usable = subs.indices.filter { !subs[it].forced }
        if (audios.size == 1 && usable.isEmpty()) return emptyList()
        val names = audioNames(audios)

        fun subLabel(a: Int, s: Int): String {
            val ac = Langs.code(audios[a].lang)
            val sn = Langs.name(subs[s].lang)
            return if (sn == null || (ac != null && ac == Langs.code(subs[s].lang))) "${names[a]} + Subtitles"
            else "${names[a]} + $sn Subtitles"
        }

        fun best(a: Int): Int? {
            val ac = Langs.code(audios[a].lang)
            return usable.firstOrNull { Langs.code(subs[it].lang) == "en" }
                ?: usable.firstOrNull { ac != null && Langs.code(subs[it].lang) == ac }
                ?: usable.firstOrNull()
        }

        val out = ArrayList<Pill>()
        fun add(p: Pill) { if (out.none { it.audio == p.audio && it.sub == p.sub }) out.add(p) }
        for (a in audios.indices) {
            add(Pill(names[a], a, -1))
            val b = best(a)
            if (b != null) add(Pill(subLabel(a, b), a, b))
            if (a == 0 && b != null) {
                // One more subtitle language for the main audio, when the file has one.
                val bc = Langs.code(subs[b].lang)
                val other = usable.firstOrNull { val c = Langs.code(subs[it].lang); c != null && c != bc }
                if (other != null) add(Pill(subLabel(0, other), 0, other))
            }
        }
        return out.take(MAX)
    }

    /**
     * Which pill matches the current selection (selAudio / selSub index the same lists as [build];
     * selSub -1 = subtitles off). A forced-only subtitle counts as off. -1 when none matches.
     */
    fun active(pills: List<Pill>, subs: List<TrackDesc>, selAudio: Int, selSub: Int): Int {
        val sub = if (selSub in subs.indices && subs[selSub].forced) -1 else selSub
        if (selAudio < 0) return -1
        return pills.indexOfFirst { it.audio == selAudio && it.sub == sub }
    }
}

/** Clock text for the player's elapsed / remaining labels. */
object TimeFmt {
    /** "02:54", or "1:02:54" once past an hour. Negative / unknown values read as zero. */
    fun clock(ms: Long): String {
        val s = (ms.coerceAtLeast(0) / 1000)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%02d:%02d".format(m, sec)
    }

    /** "-18:49" time left; "-00:00" when the duration is unknown. */
    fun remaining(posMs: Long, durMs: Long): String =
        "-" + clock(if (durMs > 0) (durMs - posMs).coerceAtLeast(0) else 0)
}

object Titles {
    /** `S1: E1 "Pilot"`; just the code without a name, just the name without numbers. */
    fun episodeLine(season: Int?, episode: Int?, name: String): String {
        val code = if (season != null && episode != null) "S$season: E$episode" else ""
        val n = name.trim()
        return when {
            code.isEmpty() -> n
            n.isEmpty() -> code
            else -> "$code \"$n\""
        }
    }
}
