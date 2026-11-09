import SwiftUI

/// What the chosen TV is playing, with back 10 / play-pause / forward 10 / stop. Refreshes every few seconds while visible.
struct NowPlayingView: View {
    @EnvironmentObject var account: Account
    @State private var now: NowPlaying?
    @State private var loaded = false
    @State private var stamp = Date()          // when `now.positionMs` was read, to keep the clock moving between polls
    @State private var problem: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                TVPicker()
                if let n = now { player(n) } else { idle }
                if let problem { Text(problem).font(.caption2).foregroundStyle(.orange) }
            }
        }
        .task(id: account.tv?.device) { await poll() }
    }

    // MARK: states
    private var idle: some View {
        VStack(spacing: 6) {
            Image(systemName: "tv").font(.largeTitle).foregroundStyle(.secondary)
            Text(!loaded ? "Checking…" : account.tv == nil ? "No TV set up" : "Nothing playing on \(account.tv!.name)")
                .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
            if loaded, account.tv != nil {
                Button("Pick something") { account.tab = .continueWatching }.font(.footnote)
            }
        }.padding(.top, 8)
    }

    private func player(_ n: NowPlaying) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                PosterView(path: n.img.flatMap { i in i.id.flatMap { id in i.tag.map { "/img/\(id)/Primary?tag=\($0)&w=160" } } })
                    .frame(width: 40, height: 60)
                VStack(alignment: .leading, spacing: 1) {
                    Text(n.title).font(.footnote.weight(.bold)).lineLimit(2)
                    if let s = n.subtitle { Text(s).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                    Text("\(account.tv?.name ?? "") · \(n.paused ? "Paused" : "Playing")").font(.caption2).foregroundStyle(.green)
                }
                Spacer(minLength: 0)
            }
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                VStack(spacing: 2) {
                    ProgressView(value: shown(n), total: 1).tint(.red)
                    Text(clock(position(n)) + (n.runtimeMs.map { " / " + clock($0) } ?? "")).font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 6) {
                control("gobackward.10", "rewind", n)
                control(n.paused ? "play.fill" : "pause.fill", n.paused ? "play" : "pause", n, big: true)
                control("goforward.10", "forward", n)
            }
            Button(role: .destructive) { Task { await send("stop", n) } } label: { Label("Stop", systemImage: "stop.fill") }
                .font(.footnote).tint(.red)
        }
    }

    private func control(_ icon: String, _ action: String, _ n: NowPlaying, big: Bool = false) -> some View {
        Button { Task { await send(action, n) } } label: {
            Image(systemName: icon).font(big ? .title3 : .body).frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered).tint(big ? .white : .gray)
    }

    // MARK: data
    private func position(_ n: NowPlaying) -> Int {
        n.paused ? n.positionMs : min(n.runtimeMs ?? .max, n.positionMs + Int(Date().timeIntervalSince(stamp) * 1000))
    }
    private func shown(_ n: NowPlaying) -> Double {
        guard let r = n.runtimeMs, r > 0 else { return 0 }
        return min(1, Double(position(n)) / Double(r))
    }
    private func clock(_ ms: Int) -> String {
        let t = max(0, ms / 1000), h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    private func refresh() async {
        guard let tv = account.tv else { loaded = true; now = nil; return }
        do {
            let n = try await account.api.now(device: tv.device)
            now = n; stamp = Date(); problem = nil
        } catch APIError.unauthorized { problem = "MyFlix didn't accept this watch. Pair on your phone." }
        catch { /* a blip keeps whatever is showing */ }
        loaded = true
    }

    private func poll() async {
        if account.targets.isEmpty { await account.loadTargets() }
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(4))
        }
    }

    private func send(_ action: String, _ n: NowPlaying) async {
        guard let tv = account.tv else { return }
        account.tap()
        if action == "pause" || action == "play" { now?.paused = (action == "pause"); now?.positionMs = position(n); stamp = Date() }   // optimistic
        do {
            try await account.api.control(device: tv.device, action: action)
            if action == "stop" { now = nil }
            try? await Task.sleep(for: .seconds(1.2))
            await refresh()
        } catch APIError.server("tv_unreachable") { problem = "Can't reach \(tv.name). Is it on?"; account.tap(.failure) }
        catch APIError.server("cast_unavailable") { problem = "\(tv.name) has no remote control set up"; account.tap(.failure) }
        catch { problem = "Couldn't send that"; account.tap(.failure) }
    }
}
