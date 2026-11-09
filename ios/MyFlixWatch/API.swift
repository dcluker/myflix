import Foundation

enum APIError: Error, Equatable {
    case notPaired
    case unauthorized                 // the server did not accept this device
    case busy(String?)                // 409 tv_busy: the TV is playing something else (its title)
    case server(String)               // an error code from the server
    case network
}

/// The handful of MyFlix endpoints the watch uses. Plain URLSession, no cookies: the Access headers are explicit.
@MainActor
final class API {
    private let account: Account
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.timeoutIntervalForRequest = 15
        return URLSession(configuration: c)
    }()

    init(account: Account) { self.account = account }

    // MARK: plumbing
    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, profile: Bool = true) throws -> URLRequest {
        guard let c = account.creds, let url = URL(string: c.myflixBase + path) else { throw APIError.notPaired }
        var r = URLRequest(url: url)
        r.httpMethod = method
        if let body { r.httpBody = try? JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if Hosts.cfEligible(c.myflixBase) {
            r.setValue(c.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
            r.setValue(c.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        }
        if profile, let p = account.profile { r.setValue(p.userId, forHTTPHeaderField: "X-MyFlix-Profile") }
        return r
    }

    private func send(_ r: URLRequest) async throws -> Data {
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: r) } catch { throw APIError.network }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(code) { return data }
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let err = obj?["error"] as? String ?? "http_\(code)"
        if code == 401 || code == 403 { throw APIError.unauthorized }
        if code == 409 { throw APIError.busy((obj?["playing"] as? String)) }
        throw APIError.server(err)
    }

    private func get<T: Decodable>(_ path: String, profile: Bool = true) async throws -> T {
        let data = try await send(try request(path, profile: profile))
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError.server("bad_response") }
    }

    // MARK: endpoints
    func profiles() async throws -> [Profile] { (try await get("/api/me", profile: false) as MeResponse).profiles }
    func targets() async throws -> [CastTarget] { try await get("/api/cast/targets") }
    func home() async throws -> HomeResponse { try await get("/api/home") }
    func search(_ q: String) async throws -> [MediaItem] {
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        return try await get("/api/search?q=\(enc)")
    }
    func now(device: String) async throws -> NowPlaying? {
        let enc = device.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? device
        return (try await get("/api/cast/now?device=\(enc)") as NowResponse).playing
    }
    func control(device: String, action: String) async throws {
        _ = try await send(try request("/api/cast/control", method: "POST", body: ["device": device, "action": action]))
    }
    func cast(device: String, itemId: String, force: Bool) async throws {
        _ = try await send(try request("/api/cast", method: "POST", body: ["device": device, "itemId": itemId, "force": force]))
    }
    func imageData(_ path: String) async -> Data? {
        guard let r = try? request(path, profile: false) else { return nil }
        return try? await send(r)
    }
}
