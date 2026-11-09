import Foundation

/// Hosts come from the Info.plist (filled from Config/Local.xcconfig), so no site-specific value lives in source.
enum Config {
    private static func plist(_ key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? ""
    }
    static var tvBase: String { "https://" + plist("MFTvHost") }
    static var hostSuffix: String { plist("MFHostSuffix") }
    static var publicMyflix: String { "https://" + plist("MFPublicMyflixHost") }
    static var publicJellyfin: String { "https://" + plist("MFPublicJellyfinHost") }
    static var version: String { (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "1.0" }
}

enum Hosts {
    /// Cloudflare Access headers may only go to https hosts under the configured domain.
    static func cfEligible(_ url: String) -> Bool {
        guard let u = URL(string: url.trimmingCharacters(in: .whitespaces)),
              u.scheme?.lowercased() == "https", let h = u.host?.lowercased() else { return false }
        let suffix = Config.hostSuffix.lowercased()
        return suffix.hasPrefix(".") && h.hasSuffix(suffix)
    }

    static func isAccessLogin(_ host: String?) -> Bool {
        guard let h = host?.lowercased() else { return false }
        return h == "cloudflareaccess.com" || h.hasSuffix(".cloudflareaccess.com")
    }
}

enum PairCode {
    /// Strips spaces/dashes, upper-cases; returns 8 chars or nil.
    static func normalize(_ raw: String) -> String? {
        let s = raw.uppercased().filter { ($0 >= "A" && $0 <= "Z") || ($0 >= "0" && $0 <= "9") }
        return s.count == 8 ? s : nil
    }
    static func format(_ chars: String) -> String {
        chars.count <= 4 ? chars : String(chars.prefix(4)) + "-" + String(chars.dropFirst(4))
    }
}
