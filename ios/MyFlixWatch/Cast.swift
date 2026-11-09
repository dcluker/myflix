import SwiftUI

extension Account {
    enum CastOutcome { case started, busy(String?), failed(String) }

    /// Plays `item` on the chosen TV. A TV that is already playing something answers "busy"; the caller asks, then retries with force.
    func cast(_ item: MediaItem, force: Bool = false) async -> CastOutcome {
        guard let tv else { return .failed("No TV set up") }
        do {
            try await api.cast(device: tv.device, itemId: item.id, force: force)
            tap(.success)
            tab = .nowPlaying
            return .started
        } catch APIError.busy(let what) { return .busy(what) }
        catch APIError.network { tap(.failure); return .failed("Can't reach MyFlix") }
        catch APIError.server("tv_unreachable") { tap(.failure); return .failed("Can't reach \(tv.name). Is it on?") }
        catch APIError.server("rate_limited") { return .failed("Slow down a little") }
        catch { tap(.failure); return .failed("Couldn't cast") }
    }
}

/// Casting state for a list: which title is waiting on a "cast anyway?" answer, and the last failure message.
@MainActor
final class Caster: ObservableObject {
    @Published var waiting: MediaItem?
    @Published var waitingFor: String?
    @Published var message: String?

    func cast(_ item: MediaItem, account: Account, force: Bool = false) async {
        switch await account.cast(item, force: force) {
        case .started: break
        case .busy(let what): waitingFor = what; waiting = item
        case .failed(let m): message = m
        }
    }
}

private struct CastAlerts: ViewModifier {
    @EnvironmentObject var account: Account
    @ObservedObject var caster: Caster

    func body(content: Content) -> some View {
        content
            .alert("\(account.tv?.name ?? "The TV") is playing\(caster.waitingFor.map { " “\($0)”" } ?? " something")",
                   isPresented: Binding(get: { caster.waiting != nil }, set: { if !$0 { caster.waiting = nil } })) {
                Button("Cast anyway") {
                    if let item = caster.waiting { caster.waiting = nil; Task { await caster.cast(item, account: account, force: true) } }
                }
                Button("Cancel", role: .cancel) { caster.waiting = nil }
            }
            .alert(caster.message ?? "", isPresented: Binding(get: { caster.message != nil }, set: { if !$0 { caster.message = nil } })) {
                Button("OK", role: .cancel) {}
            }
    }
}

extension View { func castAlerts(_ caster: Caster) -> some View { modifier(CastAlerts(caster: caster)) } }

/// "TV  Living room >" row that opens a list of TVs; only shown when there is more than one to choose from.
struct TVPicker: View {
    @EnvironmentObject var account: Account
    var body: some View {
        if account.castable.count > 1 {
            Picker("TV", selection: Binding(get: { account.tv?.device ?? "" }, set: { account.selectedTV = $0 })) {
                ForEach(account.castable) { Text($0.name).tag($0.device) }
            }
            .pickerStyle(.navigationLink)
        }
    }
}
