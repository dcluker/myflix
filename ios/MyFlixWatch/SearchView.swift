import SwiftUI

/// Type or dictate a title (tap the field: the watch offers dictation and scribble), then tap a result to play it.
struct SearchView: View {
    @EnvironmentObject var account: Account
    @StateObject private var caster = Caster()
    @State private var query = ""
    @State private var results: [MediaItem] = []
    @State private var searched = ""
    @State private var searching = false

    var body: some View {
        List {
            TVPicker()
            TextField("Search titles", text: $query)
                .submitLabel(.search)
                .onSubmit { Task { await run() } }
            if searching { ProgressView().frame(maxWidth: .infinity) }
            else if !searched.isEmpty && results.isEmpty { Text("No titles for “\(searched)”.").font(.footnote).foregroundStyle(.secondary) }
            ForEach(results) { item in
                Button { Task { await caster.cast(item, account: account) } } label: { MediaRow(item: item) }
            }
        }
        .castAlerts(caster)
        .task { if account.targets.isEmpty { await account.loadTargets() } }
    }

    private func run() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return }
        searching = true
        defer { searching = false }
        searched = q
        results = (try? await account.api.search(q)) ?? []
    }
}
