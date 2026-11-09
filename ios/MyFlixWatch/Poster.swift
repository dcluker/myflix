import SwiftUI
import UIKit

/// Posters need the Access headers, so AsyncImage cannot load them. Tiny in-memory cache, nothing on disk.
@MainActor
final class PosterCache {
    static let shared = PosterCache()
    private let cache = NSCache<NSString, UIImage>()
    func image(for path: String, account: Account) async -> UIImage? {
        if let hit = cache.object(forKey: path as NSString) { return hit }
        guard let data = await account.api.imageData(path), let img = UIImage(data: data) else { return nil }
        cache.setObject(img, forKey: path as NSString)
        return img
    }
}

struct PosterView: View {
    @EnvironmentObject var account: Account
    let path: String?
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.gray.opacity(0.25))
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: path) {
            image = nil
            guard let path else { return }
            image = await PosterCache.shared.image(for: path, account: account)
        }
    }
}

/// One title in a list: poster, title, a small line under it, and a red progress bar when partly watched.
struct MediaRow: View {
    let item: MediaItem
    var body: some View {
        HStack(spacing: 8) {
            PosterView(path: item.posterPath).frame(width: 36, height: 54)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.footnote.weight(.semibold)).lineLimit(2)
                if !item.subtitle.isEmpty { Text(item.subtitle).font(.caption2).foregroundStyle(.secondary) }
                if let p = item.playedPct, p > 0, p < 100 {
                    ProgressView(value: p, total: 100).tint(.red)
                }
            }
        }
    }
}
