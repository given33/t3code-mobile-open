import Foundation
import Security
import T3MobileCore

enum KeychainStore {
  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app.t3mobile.client",
      kSecAttrAccount as String: "paired-hosts-v1",
    ]
  }
  private static func check(_ status: OSStatus) throws {
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
  }
  static func load() throws -> [PairedHost] {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    try check(status)
    guard let data = result as? Data else { throw LinkError.response }
    return try JSONDecoder().decode([PairedHost].self, from: data)
  }
  static func save(_ hosts: [PairedHost]) throws {
    let attrs: [String: Any] = [
      kSecValueData as String: try JSONEncoder().encode(hosts),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
    if status == errSecItemNotFound {
      try check(SecItemAdd(query.merging(attrs) { _, new in new } as CFDictionary, nil))
    } else {
      try check(status)
    }
  }
}
