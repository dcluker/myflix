import Foundation

struct Profile: Codable, Identifiable, Equatable {
    let userId: String
    let name: String
    var id: String { userId }
}

struct MeResponse: Codable { let profiles: [Profile] }

/// One TV the server can drive. `enabled` is false for a TV that is named but has no remote control set up.
struct CastTarget: Codable, Identifiable, Equatable {
    let device: String
    let name: String
    let enabled: Bool
    var id: String { device }
}

struct ImageRef: Codable, Equatable { let id: String?; let tag: String? }

/// What a TV is playing right now (`/api/cast/now`).
struct NowPlaying: Codable, Equatable {
    let itemId: String
    let name: String
    let seriesName: String?
    let season: Int?
    let episode: Int?
    var paused: Bool
    var positionMs: Int
    let runtimeMs: Int?
    let img: ImageRef?

    var title: String { seriesName ?? name }
    var subtitle: String? {
        guard seriesName != nil else { return nil }
        let ep = (season != nil && episode != nil) ? "S\(season!):E\(episode!)  " : ""
        return ep + name
    }
    var fraction: Double {
        guard let r = runtimeMs, r > 0 else { return 0 }
        return min(1, max(0, Double(positionMs) / Double(r)))
    }
}
struct NowResponse: Codable { let playing: NowPlaying? }

/// A library item (movie, show or episode) as the watch needs it: a title, a subtitle, a poster and a progress bar.
struct MediaItem: Codable, Identifiable, Equatable {
    let id: String
    let type: String
    let name: String
    let year: Int?
    let seriesId: String?
    let seriesName: String?
    let season: Int?
    let episode: Int?
    let playedPct: Double?
    let img: Poster?
    let seriesImg: Poster?

    struct Poster: Codable, Equatable { let primary: String? }

    var title: String { seriesName ?? name }
    var subtitle: String {
        if type == "Episode" { return (season != nil && episode != nil ? "S\(season!):E\(episode!)" : "") }
        return year.map(String.init) ?? ""
    }
    /// The poster of the movie / show, never an episode still.
    var posterPath: String? {
        if type == "Episode", let sid = seriesId, let t = seriesImg?.primary { return "/img/\(sid)/Primary?tag=\(t)&w=160" }
        if let t = img?.primary { return "/img/\(id)/Primary?tag=\(t)&w=160" }
        return nil
    }
}

struct HomeResponse: Codable {
    let resume: [MediaItem]
    let nextUp: [MediaItem]

    /// Continue Watching: what you are partway through, then what is next, one entry per show.
    var continueList: [MediaItem] {
        var seen = Set<String>(), out: [MediaItem] = []
        for it in resume + nextUp {
            let key = it.type == "Episode" ? "s:" + (it.seriesId ?? it.id) : it.id
            if seen.insert(key).inserted { out.append(it) }
        }
        return Array(out.prefix(20))
    }
}
