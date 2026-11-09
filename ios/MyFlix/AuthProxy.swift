import Foundation
import Network

/// Tiny loopback HTTP proxy. libVLC can't attach custom headers, and the public Jellyfin host needs the
/// Cloudflare Access headers, so VLC is pointed at http://127.0.0.1:<port>/s/<id> and this adds them.
/// Streams with back-pressure so a paused player doesn't make the app buffer the whole file.
final class AuthProxy {
    static let shared = AuthProxy()

    private let queue = DispatchQueue(label: "myflix.authproxy")
    private var listener: NWListener?
    private var routes: [String: (url: URL, headers: [String: String])] = [:]
    private var port: UInt16 = 0
    private var handlers: [ObjectIdentifier: Handler] = [:]

    /// Returns a loopback URL that forwards to `url` (same path and query) with `headers` added, or nil if the
    /// listener couldn't start. Relative links inside HLS playlists resolve under the same prefix and keep working.
    func proxied(_ url: URL, headers: [String: String]) -> URL? {
        queue.sync {
            if listener == nil { startLocked() }
        }
        // The listener reports its port asynchronously; wait briefly for it.
        let deadline = Date().addingTimeInterval(2)
        while queue.sync(execute: { port }) == 0 && Date() < deadline { usleep(20_000) }
        let p = queue.sync { port }
        guard p != 0 else { return nil }
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let rest = (c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath) + (c.percentEncodedQuery.map { "?" + $0 } ?? "")
        c.percentEncodedPath = ""; c.query = nil; c.fragment = nil
        guard let origin = c.url else { return nil }
        let id = UUID().uuidString
        queue.sync { routes[id] = (origin, headers) }
        return URL(string: "http://127.0.0.1:\(p)/o/\(id)" + rest)
    }

    func forget(_ url: URL) {
        let parts = url.path.split(separator: "/")
        guard parts.count >= 2 else { return }
        let id = String(parts[1])
        queue.async { self.routes[id] = nil }
    }

    // MARK: Listener

    private func startLocked() {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        guard let l = try? NWListener(using: params, on: .any) else { return }
        l.stateUpdateHandler = { [weak self, weak l] st in
            if case .ready = st, let p = l?.port?.rawValue { self?.queue.async { self?.port = p } }
            if case .failed = st { self?.queue.async { self?.listener = nil; self?.port = 0 } }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
        listener = l
    }

    private func accept(_ conn: NWConnection) {
        let h = Handler(conn: conn, lookup: { [weak self] id in self?.routes[id] }, done: { [weak self] h in
            self?.queue.async { self?.handlers[ObjectIdentifier(h)] = nil }
        })
        handlers[ObjectIdentifier(h)] = h
        h.start(on: queue)
    }

    // MARK: One connection = one request

    private final class Handler: NSObject, URLSessionDataDelegate {
        let conn: NWConnection
        let lookup: (String) -> (url: URL, headers: [String: String])?
        let done: (Handler) -> Void
        private var buf = Data()
        private var session: URLSession?
        private var task: URLSessionDataTask?
        private var pending = 0
        private var suspended = false
        private var finished = false
        private let lock = NSLock()

        init(conn: NWConnection, lookup: @escaping (String) -> (url: URL, headers: [String: String])?, done: @escaping (Handler) -> Void) {
            self.conn = conn; self.lookup = lookup; self.done = done
        }

        func start(on q: DispatchQueue) {
            conn.stateUpdateHandler = { [weak self] st in
                switch st {
                case .failed, .cancelled: self?.close()
                default: break
                }
            }
            conn.start(queue: q)
            readRequest()
        }

        private func readRequest() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isDone, err in
                guard let self else { return }
                if let d = data { self.buf.append(d) }
                if self.buf.range(of: Data("\r\n\r\n".utf8)) != nil { self.handle(); return }
                if err != nil || isDone || self.buf.count > 64 * 1024 { self.close(); return }
                self.readRequest()
            }
        }

        private func handle() {
            guard let text = String(data: buf, encoding: .utf8) else { return respond(400) }
            let lines = text.components(separatedBy: "\r\n")
            let parts = (lines.first ?? "").split(separator: " ")
            guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { return respond(405) }
            // /o/<id><path>?<query>  ->  <origin><path>?<query>
            let target = String(parts[1])
            let segs = target.split(separator: "/", maxSplits: 2, omittingEmptySubsequences: true)
            guard segs.count >= 2, segs[0] == "o", let route = lookup(String(segs[1])) else { return respond(404) }
            let rest = segs.count > 2 ? "/" + String(segs[2]) : "/"
            guard let dest = URL(string: route.url.absoluteString + rest) else { return respond(400) }
            var req = URLRequest(url: dest)
            req.httpMethod = String(parts[0])
            req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            req.timeoutInterval = 60
            for (k, v) in route.headers { req.setValue(v, forHTTPHeaderField: k) }
            for l in lines.dropFirst() {
                guard let c = l.firstIndex(of: ":") else { continue }
                let name = l[..<c].lowercased()
                let val = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
                if name == "range" || name == "if-range" { req.setValue(val, forHTTPHeaderField: String(l[..<c])) }
            }
            let cfg = URLSessionConfiguration.ephemeral
            cfg.httpCookieStorage = nil
            cfg.httpShouldSetCookies = false
            let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
            session = s
            task = s.dataTask(with: req)
            task?.resume()
        }

        private func respond(_ code: Int) {
            let head = "HTTP/1.1 \(code) \(HTTPURLResponse.localizedString(forStatusCode: code))\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] _ in self?.close() })
        }

        // MARK: URLSession

        func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive r: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let h = r as? HTTPURLResponse else { completionHandler(.cancel); respond(502); return }
            var head = "HTTP/1.1 \(h.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: h.statusCode))\r\n"
            for name in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"] {
                if let v = h.value(forHTTPHeaderField: name) { head += "\(name): \(v)\r\n" }
            }
            if h.value(forHTTPHeaderField: "Accept-Ranges") == nil { head += "Accept-Ranges: bytes\r\n" }
            head += "Connection: close\r\n\r\n"
            conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            completionHandler(.allow)
        }

        func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock(); pending += data.count
            let pause = pending > 4 << 20 && !suspended
            if pause { suspended = true }
            lock.unlock()
            if pause { dataTask.suspend() }
            conn.send(content: data, completion: .contentProcessed { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self.pending -= data.count
                let resume = self.suspended && self.pending < 1 << 20
                if resume { self.suspended = false }
                self.lock.unlock()
                if resume { self.task?.resume() }
            })
        }

        func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            conn.send(content: nil, isComplete: true, completion: .contentProcessed { [weak self] _ in self?.close() })
        }

        private func close() {
            lock.lock()
            if finished { lock.unlock(); return }
            finished = true
            lock.unlock()
            task?.cancel()
            session?.invalidateAndCancel()
            conn.cancel()
            done(self)
        }
    }
}
