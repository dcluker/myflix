import SwiftUI

struct RootView: View {
    @EnvironmentObject var account: Account

    var body: some View {
        if account.creds == nil {
            Message(icon: "iphone.and.arrow.forward", title: "Pair on your iPhone",
                    text: "Open MyFlix on your iPhone and sign in. The watch connects by itself.")
        } else if account.profile == nil {
            ProfilePicker()
        } else {
            TabView(selection: $account.tab) {
                NavigationStack { NowPlayingView().navigationTitle("Now playing").navigationBarTitleDisplayMode(.inline) }.tag(Account.Tab.nowPlaying)
                NavigationStack { ContinueView().navigationTitle("Continue").navigationBarTitleDisplayMode(.inline) }.tag(Account.Tab.continueWatching)
                NavigationStack { SearchView().navigationTitle("Search").navigationBarTitleDisplayMode(.inline) }.tag(Account.Tab.search)
            }
            .tabViewStyle(.verticalPage)
        }
    }
}

struct Message: View {
    let icon: String, title: String, text: String
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.title2)
            Text(title).font(.headline)
            Text(text).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding()
    }
}

/// Only shown when the account has more than one profile and none is chosen yet.
struct ProfilePicker: View {
    @EnvironmentObject var account: Account
    @State private var profiles: [Profile] = []
    @State private var failed = false

    var body: some View {
        List {
            Text("Who's watching?").font(.headline)
            if profiles.isEmpty { Text(failed ? "Couldn't reach MyFlix." : "Loading…").font(.footnote).foregroundStyle(.secondary) }
            ForEach(profiles) { p in Button(p.name) { account.choose(p) } }
        }
        .task {
            do {
                profiles = try await account.api.profiles()
                if profiles.count == 1 { account.choose(profiles[0]) }
            } catch { failed = true }
        }
    }
}
