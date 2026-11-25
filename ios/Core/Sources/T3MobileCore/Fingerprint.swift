import Foundation

#if canImport(CryptoKit)
  import CryptoKit
#else
  import COpenSSL
#endif

public enum Fingerprint {
  // id-ecPublicKey + prime256v1, followed by an uncompressed X9.63 point.
  private static let prefix = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ])
  public static func spki(rawPoint: Data) -> Data? {
    guard rawPoint.count == 65, rawPoint.first == 4 else { return nil }
    return prefix + rawPoint
  }
  public static func digest(_ data: Data) -> Data {
    #if canImport(CryptoKit)
      return Data(SHA256.hash(data: data))
    #else
      var bytes = [UInt8](repeating: 0, count: 32)
      data.withUnsafeBytes {
        _ = SHA256($0.bindMemory(to: UInt8.self).baseAddress, data.count, &bytes)
      }
      return Data(bytes)
    #endif
  }
  public static func encode(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  public static func safetyCode(_ pin: String) -> String? {
    let base = pin.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard pin.utf8.count == 43, let data = Data(base64Encoded: base + "="), data.count == 32,
      encode(data) == pin
    else { return nil }
    return stride(from: 0, to: 8, by: 2).map { String(format: "%02X%02X", data[$0], data[$0 + 1]) }
      .joined(separator: " ")
  }

  /// Read the validity and actual SPKI TLVs from Security.framework's parsed leaf.
  /// A CA chain or a different curve with a similarly sized key cannot substitute for this key.
  public static func certificatePin(_ der: Data, now: Date = Date()) -> String? {
    var cert = DER(der[...])
    guard var envelope = cert.read(0x30), cert.bytes.isEmpty, var tbs = envelope.read(0x30) else {
      return nil
    }
    if tbs.bytes.first == 0xa0, tbs.read(0xa0) == nil { return nil }
    guard tbs.read(2) != nil, tbs.read(0x30) != nil, tbs.read(0x30) != nil,
      var validity = tbs.read(0x30), let from = validity.time(), let until = validity.time(),
      validity.bytes.isEmpty, from <= now, now < until, tbs.read(0x30) != nil
    else { return nil }
    let start = tbs.bytes
    guard tbs.read(0x30) != nil else { return nil }
    let actual = Data(start.prefix(start.count - tbs.bytes.count))
    guard let expected = spki(rawPoint: Data(actual.suffix(65))), actual == expected else {
      return nil
    }
    return encode(digest(actual))
  }
}

private struct DER {
  var bytes: Data.SubSequence
  init(_ bytes: Data.SubSequence) { self.bytes = bytes }
  mutating func read(_ tag: UInt8) -> DER? {
    guard bytes.popFirst() == tag, let first = bytes.popFirst() else { return nil }
    var n = Int(first)
    if n >= 128 {
      let width = n - 128
      guard (1...4).contains(width), bytes.count >= width, bytes.first != 0 else { return nil }
      n = bytes.prefix(width).reduce(0) { $0 * 256 + Int($1) }
      bytes = bytes.dropFirst(width)
      guard n >= 128 else { return nil }
    }
    guard bytes.count >= n else { return nil }
    defer { bytes = bytes.dropFirst(n) }
    return DER(bytes.prefix(n))
  }
  mutating func time() -> Date? {
    guard let tag = bytes.first, tag == 23 || tag == 24, let item = read(tag),
      let s = String(data: item.bytes, encoding: .ascii), s.last == "Z",
      s.count == (tag == 23 ? 13 : 15), s.dropLast().allSatisfy(\.isNumber)
    else { return nil }
    let yearPrefix = tag == 23 ? (s.prefix(2) < "50" ? "20" : "19") : ""
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.timeZone = TimeZone(secondsFromGMT: 0)
    format.dateFormat = "yyyyMMddHHmmss'Z'"
    format.isLenient = false
    return format.date(from: yearPrefix + s)
  }
}
