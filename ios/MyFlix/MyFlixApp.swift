import SwiftUI
import WebKit

extension Notification.Name {
    static let deviceShaken = Notification.Name("myflix.deviceShaken")
}

// Shake opens the menu (version, reload, sign out) without needing a visible button on the page.
extension UIWindow {
    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .deviceShaken, object: nil) }
        super.motionEnded(motion, with: event)
    }
}

final class AppState: ObservableObject {
    @Published var creds: Credentials? = Net.shared.creds
    @Published var showMenu = false
    @Published var reloadToken = 0

    func paired(_ c: Credentials) {
        Net.shared.setCreds(c)
        creds = c
    }

    func signOut() {
        Net.shared.setCreds(nil)
        let store = WKWebsiteDataStore.default()
        store.fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { recs in
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: recs) {}
        }
        creds = nil
    }
}

@main
struct MyFlixApp: App {
    @StateObject private var state = AppState()

    init() { WatchBridge.shared.start() }

    var body: some Scene {
        WindowGroup {
            Group {
                if state.creds != nil {
                    WebShell(state: state).ignoresSafeArea(.keyboard)
                } else {
                    PairView(state: state)
                }
            }
            .background(Color(red: 0.08, green: 0.08, blue: 0.08).ignoresSafeArea())
            .preferredColorScheme(.dark)
            .onReceive(NotificationCenter.default.publisher(for: .deviceShaken)) { _ in
                if state.creds != nil { state.showMenu = true }
            }
            .confirmationDialog("MyFlix \(Config.version)\(state.creds.map { $0.name.isEmpty ? "" : " · paired as \($0.name)" } ?? "")",
                                isPresented: $state.showMenu, titleVisibility: .visible) {
                Button("Reload") { state.reloadToken += 1 }
                Button("Sign out", role: .destructive) { state.signOut() }
                Button("Close", role: .cancel) {}
            }
        }
    }
}
