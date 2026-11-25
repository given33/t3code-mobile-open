import Foundation
import T3MobileCore
import WebKit

struct BrowserSession: Identifiable {
  let id = UUID(), hostID: String, endpoint: Endpoint, fingerprint, cookieName, cookieValue: String
  let actions, terminal: Bool, family: FamilyRoute?, cookie: HTTPCookie
  let expiresAt: Date
  var origin: URL { endpoint.origin }
  var storeID: UUID { Self.storeID(hostID, fingerprint) }
  static func storeID(_ id: String, _ pin: String) -> UUID {
    // Scope also to the authenticated key: re-pairing an ID with a new key must not inherit browser data.
    var b = Array(Fingerprint.digest(Data(("browser:" + id + ":" + pin).utf8)).prefix(16))
    b[6] = (b[6] & 15) | 0x80
    b[8] = (b[8] & 63) | 0x80
    return UUID(
      uuid: (
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13],
        b[14], b[15]
      ))
  }
  init(node: PairedHost, endpoint: Endpoint, meta: WebSessionResponse, response: HTTPURLResponse)
    throws
  {
    guard meta.cookieName == Wire.cookie,
      let header = response.value(forHTTPHeaderField: "Set-Cookie")
    else { throw LinkError.response }
    let flags = header.components(separatedBy: ";").dropFirst().map {
      $0.trimmingCharacters(in: .whitespaces).lowercased()
    }
    let parsed = HTTPCookie.cookies(
      withResponseHeaderFields: ["Set-Cookie": header], for: endpoint.origin)
    guard flags.contains("samesite=strict"), !flags.contains(where: { $0.hasPrefix("domain=") }),
      parsed.count == 1,
      let c = parsed.first, c.name == Wire.cookie, c.isHTTPOnly, c.isSecure, c.path == "/",
      Wire.validSecret(c.value),
      let ageFlag = flags.first(where: { $0.hasPrefix("max-age=") }),
      let age = Int(ageFlag.dropFirst(8)), (1...3600).contains(age)
    else { throw LinkError.response }
    expiresAt = min(c.expiresDate ?? .distantFuture, Date().addingTimeInterval(Double(age)))
    guard expiresAt > Date() else { throw LinkError.response }
    hostID = node.host.id
    fingerprint = node.fingerprint
    self.endpoint = endpoint
    family = meta.family
    actions = meta.actions
    terminal = meta.terminal
    cookieName = c.name
    cookieValue = c.value
    cookie = c
  }
}
