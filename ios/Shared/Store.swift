import Foundation
import Security

struct Credentials: Codable, Equatable {
    var clientId: String
    var clientSecret: String
    var name: String
    var myflixBase: String
    var jellyfinBase: String
}

/// Pairing credentials live in the Keychain (this device only, never in backups or iCloud).
enum Store {
    private static let service = "dev.theprivatehome.myflix"
    private static let account = "pairing"

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func load() -> Credentials? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: d)
    }

    static func save(_ c: Credentials) {
        guard let d = try? JSONEncoder().encode(c) else { return }
        SecItemDelete(query() as CFDictionary)
        var q = query()
        q[kSecValueData as String] = d
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func clear() { SecItemDelete(query() as CFDictionary) }

    /// Random per-install id, reported to Jellyfin as DeviceId.
    static var deviceId: String {
        if let id = UserDefaults.standard.string(forKey: "deviceId") { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "deviceId")
        return id
    }
}
