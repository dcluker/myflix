import SwiftUI
import WebKit

/// The MyFlix site in a WKWebView, authenticated to Cloudflare Access with the paired service token.
/// Playing a title (a navigation to /play/<id>) is handed to the native player instead.
struct WebShell: UIViewControllerRepresentable {
    @ObservedObject var state: AppState
    func makeUIViewController(context: Context) -> WebVC { WebVC(state: state) }
    func updateUIViewController(_ vc: WebVC, context: Context) {
        if vc.lastReloadToken != state.reloadToken {
            vc.lastReloadToken = state.reloadToken
            vc.loadStart()
        }
    }
}

final class WebVC: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let state: AppState
    var lastReloadToken = 0
    private var web: WKWebView!
    private var errorBox: UIView?
    private var retries = 0
    private var lastCookieRefresh = Date()
    private var authFailed = false
    private var cookieTimer: Timer?
    private let myflixHost: String
    private let startURL: String

    init(state: AppState) {
        self.state = state
        self.lastReloadToken = state.reloadToken
        let base = Net.shared.myflixBase
        myflixHost = URL(string: base)?.host ?? ""
        // ?tv=0 pins the phone/tablet layout even if a TV flag was ever stored.
        startURL = base + "/?tv=0"
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.08, green: 0.08, blue: 0.08, alpha: 1)
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.applicationNameForUserAgent = "MyFlixApp/\(Config.version) iOS"
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = self
        web.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: g.topAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: g.leadingAnchor), web.trailingAnchor.constraint(equalTo: g.trailingAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        cookieTimer = Timer.scheduledTimer(withTimeInterval: 2 * 3600, repeats: true) { [weak self] _ in self?.refreshCookie() }
        loadStart()
    }

    deinit { cookieTimer?.invalidate() }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    func loadStart() {
        removeError()
        lastCookieRefresh = Date()
        guard var r = Net.shared.request(startURL) else { return }
        r.cachePolicy = .reloadIgnoringLocalCacheData
        web.load(r)
    }

    // MARK: Access cookie

    @objc private func becameActive() {
        if Date().timeIntervalSince(lastCookieRefresh) > 30 * 60 { refreshCookie() }
    }

    private func refreshCookie() {
        lastCookieRefresh = Date()
        Task {
            let cookies = await Net.shared.fetchAccessCookies()
            await MainActor.run {
                for c in cookies { web.configuration.websiteDataStore.httpCookieStore.setCookie(c) }
            }
        }
    }

    // MARK: Navigation

    private func retryOrFail() {
        if retries < 2 { retries += 1; loadStart() } else { showError() }
    }

    /// Voice search: let the MyFlix page use the microphone (iOS still asks the user once).
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone ? .prompt : .deny)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { decisionHandler(.allow); return }
        if Hosts.isAccessLogin(url.host) {
            decisionHandler(.cancel)
            retryOrFail()
            return
        }
        guard url.host == myflixHost else { decisionHandler(.cancel); return }   // nothing off-site
        if url.path.hasPrefix("/play/") {
            let id = String(url.path.dropFirst("/play/".count)).split(separator: "/").first.map(String.init) ?? ""
            let live = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "live" && $0.value == "1" } ?? false
            decisionHandler(.cancel)
            if !id.isEmpty { openPlayer(id, live: live) }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let h = response.response as? HTTPURLResponse, response.isForMainFrame, h.statusCode == 401 || h.statusCode == 403 {
            decisionHandler(.cancel)
            authFailed = true
            retryOrFail()
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.host == myflixHost { retries = 0; authFailed = false; removeError() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showError()
    }

    // MARK: Error screen

    private func showError() {
        guard errorBox == nil else { return }
        let box = UIView()
        box.backgroundColor = view.backgroundColor
        box.translatesAutoresizingMaskIntoConstraints = false
        let msg = UILabel()
        msg.numberOfLines = 0
        msg.textAlignment = .center
        msg.textColor = .white
        msg.font = .systemFont(ofSize: 18)
        msg.text = authFailed
            ? "MyFlix didn't accept this device.\nIt may have been removed. Try again, or sign out and pair with a new code."
            : "Can't reach MyFlix.\nCheck your connection and try again."
        func button(_ title: String, _ filled: Bool, _ action: @escaping () -> Void) -> UIButton {
            var c = filled ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
            c.title = title
            c.baseBackgroundColor = filled ? .white : UIColor(white: 0.2, alpha: 1)
            c.baseForegroundColor = filled ? .black : .white
            return UIButton(configuration: c, primaryAction: UIAction { _ in action() })
        }
        let retry = button("Retry", true) { [weak self] in self?.retries = 0; self?.authFailed = false; self?.loadStart() }
        let out = button("Sign out", false) { [weak self] in self?.state.signOut() }
        let stack = UIStackView(arrangedSubviews: [msg, retry, out])
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)
        view.addSubview(box)
        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: view.topAnchor), box.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            box.leadingAnchor.constraint(equalTo: view.leadingAnchor), box.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: box.centerYAnchor), stack.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 340),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: box.leadingAnchor, constant: 24),
        ])
        errorBox = box
    }

    private func removeError() { errorBox?.removeFromSuperview(); errorBox = nil }

    // MARK: Player hand-off

    private func openPlayer(_ itemId: String, live: Bool = false) {
        web.evaluateJavaScript("(function(){try{return localStorage.getItem('myflix.profile')}catch(e){return null}})()") { [weak self] raw, _ in
            guard let self, let s = raw as? String,
                  let d = s.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let uid = o["userId"] as? String, !uid.isEmpty else { return }
            guard self.presentedViewController == nil else { return }
            let p = PlayerVC(itemId: itemId, profileId: uid, live: live)
            p.modalPresentationStyle = .fullScreen
            self.present(p, animated: true)
        }
    }
}
