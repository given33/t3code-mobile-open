import Foundation

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif
public enum HostRole: String, Codable, Sendable { case local, cloud }
public struct HostIdentity: Codable, Hashable, Sendable {
  public let id, name: String
  public let role: HostRole
  public init(id: String, name: String, role: HostRole) {
    self.id = id
    self.name = name
    self.role = role
  }
}
public struct FamilyPeer: Codable, Equatable, Sendable {
  public let id, name, displayName: String
  public let role: HostRole
  public let fingerprint: String
  public let hosts: [String]
}
public struct FamilyRoute: Codable, Equatable, Sendable {
  public let familyId: String
  public let role: HostRole
  public let peer: FamilyPeer
  public func validated(for host: HostIdentity) throws -> Self {
    guard PairLink.validID(familyId), PairLink.validID(peer.id), peer.id != host.id,
      role == host.role,
      peer.role != role, Fingerprint.safetyCode(peer.fingerprint) != nil,
      (1...8).contains(peer.hosts.count)
    else { throw PairError.invalid }
    _ = try peer.hosts.map(Endpoint.init)
    return self
  }
}
public struct PairedHost: Codable, Equatable, Sendable {
  public var host: HostIdentity
  public let hosts: [String], fingerprint, deviceId, token: String
  public var family: FamilyRoute?
  public init(
    host: HostIdentity, hosts: [String], fingerprint: String, deviceId: String, token: String,
    family: FamilyRoute?
  ) {
    self.host = host
    self.hosts = hosts
    self.fingerprint = fingerprint
    self.deviceId = deviceId
    self.token = token
    self.family = family
  }
}
public enum PairError: LocalizedError {
  case invalid, identity
  public var errorDescription: String? {
    switch self {
    case .invalid: return "配对信息无效，请在宿主面板刷新二维码。"
    case .identity: return "主机身份或 Family 不匹配，已停止连接。"
    }
  }
}
public struct Endpoint: Hashable, Sendable {
  public let origin: URL
  public var authority: String { String(origin.absoluteString.dropFirst(8)) }
  public init(_ value: String) throws {
    guard value.utf8.count <= 255, value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
      !value.contains(where: { ",@\\?#%".contains($0) }),
      var c = URLComponents(string: value.contains("://") ? value : "https://" + value),
      c.scheme?.lowercased() == "https", c.user == nil, c.password == nil,
      c.path == "" || c.path == "/", let host = c.host?.lowercased(), !host.isEmpty,
      c.port.map({ (1...65535).contains($0) }) ?? true
    else { throw PairError.invalid }
    if host.contains(":") {
      var addr = in6_addr()
      guard
        inet_pton(AF_INET6, host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), &addr)
          == 1
      else { throw PairError.invalid }
    } else {
      let normalized = host.hasSuffix(".") ? String(host.dropLast()) : host
      let labels = normalized.split(separator: ".", omittingEmptySubsequences: false)
      guard host.utf8.count <= 253,
        labels.allSatisfy({
          !$0.isEmpty && $0.utf8.count <= 63 && $0.first != "-" && $0.last != "-"
            && $0.utf8.allSatisfy {
              (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
            }
        })
      else { throw PairError.invalid }
    }
    c.scheme = "https"
    c.host = host
    c.path = ""
    if c.port == 443 { c.port = nil }
    guard let url = c.url else { throw PairError.invalid }
    origin = url
  }
  public var isLAN: Bool {
    let h = (origin.host ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if h.contains(":") {
      var address = in6_addr()
      guard inet_pton(AF_INET6, h, &address) == 1 else { return false }
      return withUnsafeBytes(of: address) { b in
        h == "::1" || b[0] & 0xfe == 0xfc || (b[0] == 0xfe && b[1] & 0xc0 == 0x80)
      }
    }
    let p = h.split(separator: ".").compactMap { UInt8($0) }
    if p.count == 4 {
      return p[0] == 10 || p[0] == 127 || (p[0] == 192 && p[1] == 168)
        || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 169 && p[1] == 254)
    }
    return h == "localhost" || h.hasSuffix(".local") || !h.contains(".")
  }
  public func matches(_ url: URL?) -> Bool {
    guard let url, url.scheme?.lowercased() == "https", url.user == nil, url.password == nil else {
      return false
    }
    return url.host?.lowercased() == origin.host?.lowercased()
      && (url.port ?? 443) == (origin.port ?? 443)
  }
}
public struct PairLink: Sendable {
  public let host: HostIdentity, pin, code, safetyCode: String, endpoints: [Endpoint]
  static func validID(_ s: String) -> Bool {
    s.range(of: #"\A[A-Za-z0-9_.-]{1,96}\z"#, options: .regularExpression) != nil
  }
  public init(_ uri: String) throws {
    // Node uses URLSearchParams (form encoding), so '+' is a space and %2B is a literal '+'.
    guard uri.utf8.count <= 8192,
      let c = URLComponents(string: uri.replacingOccurrences(of: "+", with: "%20")),
      c.scheme == "t3mobile", c.host == "pair", c.path.isEmpty, c.port == nil, c.user == nil,
      c.password == nil, c.fragment == nil, let items = c.queryItems
    else { throw PairError.invalid }
    var f: [String: String] = [:]
    for item in items {
      guard f[item.name] == nil, let v = item.value else { throw PairError.invalid }
      f[item.name] = v
    }
    guard f.count == 7, f["v"] == "1", let id = f["id"], Self.validID(id), let name = f["name"],
      !name.isEmpty,
      name.utf8.count <= 96, let role = HostRole(rawValue: f["role"] ?? ""), let pin = f["pin"],
      let safety = Fingerprint.safetyCode(pin), let code = f["code"],
      code.range(of: #"\A[A-Za-z0-9_-]{24}\z"#, options: .regularExpression) != nil,
      let hosts = f["hosts"]
    else { throw PairError.invalid }
    let raw = hosts.components(separatedBy: ",")
    guard (1...8).contains(raw.count) else { throw PairError.invalid }
    endpoints = try raw.map(Endpoint.init)
    self.pin = pin
    self.code = code
    safetyCode = safety
    host = HostIdentity(id: id, name: name, role: role)
  }
}
