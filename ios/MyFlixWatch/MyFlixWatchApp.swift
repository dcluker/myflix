import SwiftUI

@main
struct MyFlixWatchApp: App {
    @StateObject private var account = Account()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(account)
        }
    }
}
