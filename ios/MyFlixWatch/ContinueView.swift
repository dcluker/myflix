import SwiftUI

/// Continue Watching: partway-through titles and what is next. Tap one to play it on the TV.
struct ContinueView: View {
    @EnvironmentObject var account: Account
    @StateObject private var caster = Caster()
    @State private var items: [MediaItem] = []
    @State private var loaded = false
    @State private var failed = false

    var body: some View {
        List {
            TVPicker()
            if !loaded {
                ProgressView().frame(maxWidth: .infinity)
            } else if items.isEmpty {
                Text(failed ? "Couldn't load your list." : "Nothing to continue yet.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                Button { Task { await caster.cast(item, account: account) } } label: { MediaRow(item: item) }
            }
        }
        .castAlerts(caster)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        if account.targets.isEmpty { await account.loadTargets() }
        do { items = try await account.api.home().continueList; failed = false }
        catch { failed = items.isEmpty }
        loaded = true
    }
}
