import Foundation
import SwiftUI
import WatchConnectivity
import WatchKit

/// Who this watch is: the credentials the phone sends, the chosen profile, the TVs, and which tab is showing.
@MainActor
final class Account: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var creds: Credentials? = Store.load()
    @Published private(set) var profile: Profile? = Account.savedProfile()
    @Published private(set) var targets: [CastTarget] = []
    @Published var tab: Tab = .nowPlaying
    @AppStorage("tv") var selectedTV = ""          // the TV commands go to (device name)

    enum Tab: Hashable { case nowPlaying, continueWatching, search }

    lazy var api = API(account: self)

    var ready: Bool { creds != nil && profile != nil }
    var castable: [CastTarget] { targets.filter(\.enabled) }
    /// The TV to use: the saved choice if it still exists, else the first one.
    var tv: CastTarget? { castable.first { $0.device == selectedTV } ?? castable.first }

    override init() {
        super.init()
        #if DEBUG
        // Simulator only: `defaults write <bundle id> debugCreds -data <hex of the credentials JSON>` stands in for the phone.
        if creds == nil, let d = UserDefaults.standard.data(forKey: "debugCreds"), let c = try? JSONDecoder().decode(Credentials.self, from: d) { creds = c }
        switch UserDefaults.standard.string(forKey: "debugTab") { case "continue": tab = .continueWatching; case "search": tab = .search; default: break }
        #endif
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }

    // MARK: profile + TVs
    private static func savedProfile() -> Profile? {
        UserDefaults.standard.data(forKey: "profile").flatMap { try? JSONDecoder().decode(Profile.self, from: $0) }
    }
    func choose(_ p: Profile) {
        profile = p
        UserDefaults.standard.set(try? JSONEncoder().encode(p), forKey: "profile")
    }
    func loadTargets() async {
        if let t = try? await api.targets() { targets = t }
    }

    // MARK: credentials from the phone
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let ctx = session.receivedApplicationContext
        Task { @MainActor in self.apply(ctx) }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        Task { @MainActor in self.apply(ctx) }
    }
    private func apply(_ ctx: [String: Any]) {
        guard let data = ctx["creds"] as? Data else { return }
        if data.isEmpty {                                  // signed out on the phone
            Store.clear(); creds = nil; profile = nil; targets = []
            UserDefaults.standard.removeObject(forKey: "profile")
        } else if let c = try? JSONDecoder().decode(Credentials.self, from: data), c != creds {
            Store.save(c); creds = c
        }
    }

    // MARK: feedback
    func tap(_ type: WKHapticType = .click) { WKInterfaceDevice.current().play(type) }
}
