import Foundation
import UIKit

struct PlayInfoError: Error {
    let code: Int
    let errorCode: String?
    var message: String {
        switch (errorCode, code) {
        case ("too_high_bitrate", _): return "This title's file is too large to stream over the internet."
        case ("too_many_streams", _): return "Too many people are streaming right now. Try again in a minute."
        case (_, 404): return "This title can't be played (no playable media found)."
        case (_, 401), (_, 403): return "MyFlix didn't accept this device. It may have been removed; try signing out and pairing again."
        default: return "The server returned an error (HTTP \(code))."
        }
    }
}

/// One URLSession with no cookie jar: the Access headers are explicit, never ambient.
final class Net {
    static let shared = Net()
    private(set) var creds: Credentials? = Store.load()
    let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.timeoutIntervalForRequest = 45
        return URLSession(configuration: c)
    }()

    var paired: Bool { creds != nil }
    var myflixBase: String { creds?.myflixBase ?? "" }

    func setCreds(_ c: Credentials?) {
        if let c { Store.save(c) } else { Store.clear() }
        creds = c
        WatchBridge.shared.push()
    }

    func cfHeaders(for url: String) -> [String: String] {
        guard let c = creds, Hosts.cfEligible(url) else { return [:] }
        return ["CF-Access-Client-Id": c.clientId, "CF-Access-Client-Secret": c.clientSecret]
    }

    func request(_ url: String, method: String = "GET", body: Data? = nil, headers: [String: String] = [:]) -> URLRequest? {
        guard let u = URL(string: url) else { return nil }
        var r = URLRequest(url: u)
        r.httpMethod = method
        r.httpBody = body
        if body != nil { r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        for (k, v) in cfHeaders(for: url) { r.setValue(v, forHTTPHeaderField: k) }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    /// GET /api/playinfo/<id> (or /api/livetv/play/<id> for a live channel) for the chosen profile.
    func fetchPlayInfo(itemId: String, profileUserId: String, live: Bool = false) async throws -> [String: Any] {
        guard let r = request("\(myflixBase)/api/\(live ? "livetv/play" : "playinfo")/\(itemId)",
                              headers: ["X-MyFlix-Profile": profileUserId, "Accept": "application/json"]) else { throw URLError(.badURL) }
        let (data, resp) = try await session.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let err = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw PlayInfoError(code: code, errorCode: err)
        }
        guard let j = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.cannotParseResponse) }
        return j
    }

    /// POST /api/livetv/stop: frees the Jellyfin live stream behind a transcoded channel. Best effort.
    func stopLive(liveStreamId: String, profileUserId: String) async {
        guard let body = try? JSONSerialization.data(withJSONObject: ["liveStreamId": liveStreamId]),
              let r = request("\(myflixBase)/api/livetv/stop", method: "POST", body: body,
                              headers: ["X-MyFlix-Profile": profileUserId, "Content-Type": "application/json"]) else { return }
        _ = try? await session.data(for: r)
    }

    func jellyfinAuth(token: String) -> String {
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\\", with: "") }
        return "MediaBrowser Client=\"MyFlix iOS\", Device=\"\(esc(UIDevice.current.model))\", DeviceId=\"\(Store.deviceId)\", Version=\"\(Config.version)\", Token=\"\(token)\""
    }

    func postJellyfin(base: String, path: String, token: String, json: [String: Any]) async {
        guard let body = try? JSONSerialization.data(withJSONObject: json),
              let r = request(base + path, method: "POST", body: body,
                              headers: ["Authorization": jellyfinAuth(token: token)]) else { return }
        _ = try? await session.data(for: r)
    }

    /// A fresh CF_Authorization cookie, fetched with the service-token headers.
    func fetchAccessCookies() async -> [HTTPCookie] {
        guard let url = URL(string: myflixBase + "/"),
              let r = request(myflixBase + "/", headers: ["Accept": "text/html"]),
              let (_, resp) = try? await session.data(for: r),
              let h = resp as? HTTPURLResponse else { return [] }
        let fields = h.allHeaderFields.reduce(into: [String: String]()) { if let k = $1.key as? String, let v = $1.value as? String { $0[k] = v } }
        return HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).filter { $0.name == "CF_Authorization" }
    }
}

enum PairResult {
    case success(Credentials)
    case malformed, wrongCode, rateLimited, offline, badResponse
    case server(Int)

    var message: String {
        switch self {
        case .success: return ""
        case .malformed: return "That code doesn't look right. It has 8 letters and numbers."
        case .wrongCode: return "That code wasn't found. It may have expired or been used already."
        case .rateLimited: return "Too many tries. Wait a minute and try again."
        case .offline: return "Can't reach MyFlix. Check your connection."
        case .badResponse: return "The server's answer wasn't usable."
        case .server(let c): return "The server returned an error (HTTP \(c))."
        }
    }
}

enum PairClient {
    static func pair(rawCode: String, label: String) async -> PairResult {
        guard let code = PairCode.normalize(rawCode) else { return .malformed }
        let body = try? JSONSerialization.data(withJSONObject: ["code": PairCode.format(code), "deviceLabel": String(label.trimmingCharacters(in: .whitespaces).prefix(64))])
        guard let url = URL(string: Config.tvBase + "/pair") else { return .badResponse }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.httpBody = body
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await Net.shared.session.data(for: r)
            switch (resp as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200: return parse(data)
            case 400: return .malformed
            case 404: return .wrongCode
            case 429: return .rateLimited
            case let c: return .server(c)
            }
        } catch { return .offline }
    }

    private static func parse(_ data: Data) -> PairResult {
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = j["clientId"] as? String, let secret = j["clientSecret"] as? String,
              !id.isEmpty, !secret.isEmpty else { return .badResponse }
        let my = (j["myflixBase"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Config.publicMyflix
        let jf = (j["jellyfinBase"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Config.publicJellyfin
        // The credentials only ever go to https hosts under our domain.
        guard Hosts.cfEligible(my), Hosts.cfEligible(jf) else { return .badResponse }
        let trim = { (s: String) in s.hasSuffix("/") ? String(s.dropLast()) : s }
        return .success(Credentials(clientId: id, clientSecret: secret, name: (j["name"] as? String) ?? "",
                                    myflixBase: trim(my), jellyfinBase: trim(jf)))
    }
}
