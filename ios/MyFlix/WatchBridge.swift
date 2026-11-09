import Foundation
import WatchConnectivity

/// Hands the pairing credentials to the Apple Watch app (WatchConnectivity is encrypted between your paired devices).
/// The watch never pairs on its own: pair MyFlix on this device and the watch follows; sign out here and it signs out too.
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Sends the current credentials (or an empty value after sign-out). Safe to call any time; no-op without a watch app.
    func push() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated, s.isWatchAppInstalled else { return }
        let data = Net.shared.creds.flatMap { try? JSONEncoder().encode($0) } ?? Data()
        try? s.updateApplicationContext(["creds": data])
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) { push() }
    func sessionWatchStateDidChange(_ session: WCSession) { push() }          // the watch app was just installed
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }    // switched to another watch
}
