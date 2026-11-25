import Foundation
import Security
import T3MobileCore

struct Timed<Value> {
  let value: Value
  let latencyMs: Int
}
enum LinkError: LocalizedError {
  case response
  case status(Int)
  case noEndpoint
  var errorDescription: String? {
    switch self {
    case .response: return "主机返回了无效的会话。"
    case .status(401): return "设备未获授权或授权已撤销，请重新配对或检查 Family 授权。"
    case .status(403): return "请求被拒绝；配对码可能已失效。"
    case .status(429): return "请求过于频繁，请稍后重试。"
    case .status(let n): return "主机请求失败（\(n)）。"
    case .noEndpoint: return "没有可用的固定地址，请检查网络和主机。"
    }
  }
}
struct PinPolicy: Sendable {
  let endpoint: Endpoint, fingerprint: String
  func accepts(_ trust: SecTrust) -> Bool {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first,
      let actual = Fingerprint.certificatePin(SecCertificateCopyData(leaf) as Data)
    else { return false }
    return actual == fingerprint
  }
  func answer(
    _ challenge: URLAuthenticationChallenge,
    _ finish: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let space = challenge.protectionSpace
    let brackets = CharacterSet(charactersIn: "[]")
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      space.proxyType == nil,
      space.host.lowercased().trimmingCharacters(in: brackets)
        == endpoint.origin.host?.lowercased().trimmingCharacters(in: brackets),
      space.port == (endpoint.origin.port ?? 443), let trust = space.serverTrust, accepts(trust)
    else {
      finish(.cancelAuthenticationChallenge, nil)
      return
    }
    finish(.useCredential, URLCredential(trust: trust))
  }
}
final class PinnedTransport: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let policy: PinPolicy
  private var session: URLSession!
  init(_ endpoint: Endpoint, pin: String) {
    policy = PinPolicy(endpoint: endpoint, fingerprint: pin)
    super.init()
    let c = URLSessionConfiguration.ephemeral
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    c.urlCredentialStorage = nil
    c.urlCache = nil
    c.timeoutIntervalForRequest = 5
    c.timeoutIntervalForResource = 8
    c.tlsMinimumSupportedProtocolVersion = .TLSv12
    session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }
  func close() { session.invalidateAndCancel() }
  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    policy.answer(challenge, completionHandler)
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    policy.answer(challenge, completionHandler)
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }

  private func request<T: Decodable>(
    _ type: T.Type, _ path: String, _ method: String, token: String? = nil,
    body: Data? = nil
  ) async throws -> (Timed<T>, HTTPURLResponse) {
    let u = policy.endpoint.origin.appendingPathComponent(String(path.dropFirst()))
    var req = URLRequest(url: u)
    req.httpMethod = method
    req.httpBody = body
    if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let token {
      guard Wire.validSecret(token) else { throw LinkError.response }
      req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    }
    let start = ProcessInfo.processInfo.systemUptime
    let (data, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse, http.url == u else { throw LinkError.response }
    guard http.statusCode == 200 else { throw LinkError.status(http.statusCode) }
    let value = try JSONDecoder().decode(type, from: data)
    return (
      Timed(value: value, latencyMs: Int((ProcessInfo.processInfo.systemUptime - start) * 1000)),
      http
    )
  }
  func hello(_ expected: HostIdentity) async throws -> Timed<HelloResponse> {
    let (r, _) = try await request(HelloResponse.self, Wire.hello, "GET")
    try r.value.verify(expected, pin: policy.fingerprint)
    return r
  }
  func pair(_ link: PairLink, name: String) async throws -> PairedHost {
    _ = try await hello(link.host)
    let body = try JSONEncoder().encode(PairRequest(code: link.code, name: name))
    let (r, _) = try await request(PairResponse.self, Wire.pair, "POST", body: body)
    let p = r.value
    try p.verify(link.host)
    guard Wire.validSecret(p.token), !p.deviceId.isEmpty else { throw LinkError.response }
    return PairedHost(
      host: p.host, hosts: link.endpoints.map(\.authority), fingerprint: link.pin,
      deviceId: p.deviceId, token: p.token, family: p.family)
  }
  func sync(_ node: PairedHost) async throws -> Timed<SyncResponse> {
    _ = try await hello(node.host)
    let (r, _) = try await request(SyncResponse.self, Wire.sync, "GET", token: node.token)
    try r.value.verify(node.host)
    guard r.value.ok else { throw LinkError.response }
    return r
  }
  func webSession(_ node: PairedHost) async throws -> BrowserSession {
    _ = try await hello(node.host)
    let (r, response) = try await request(
      WebSessionResponse.self, Wire.webSession, "POST", token: node.token)
    try r.value.verify(node.host)
    return try BrowserSession(
      node: node, endpoint: policy.endpoint, meta: r.value, response: response)
  }
  func checkpoint(_ node: PairedHost, _ value: HandoffRequest) async throws {
    _ = try await hello(node.host)
    let (r, _) = try await request(CheckpointResponse.self, Wire.checkpoint, "POST", token: node.token,
                                   body: JSONEncoder().encode(value))
    guard r.value.ok && r.value.handoffId == value.handoffId else { throw LinkError.response }
  }
  func claimedRoute(_ node: PairedHost, _ value: HandoffRequest) async throws -> String {
    _ = try await hello(node.host)
    let (r, _) = try await request(HandoffResponse.self, Wire.claims + value.handoffId, "GET", token: node.token)
    guard let route = r.value.route(for: value) else { throw LinkError.response }
    return route
  }
  func handoff(_ node: PairedHost, _ value: HandoffRequest) async throws -> String {
    _ = try await hello(node.host)
    let (r, _) = try await request(HandoffResponse.self, Wire.handoff, "POST", token: node.token,
                                   body: JSONEncoder().encode(value))
    guard let route = r.value.route(for: value) else { throw LinkError.response }
    return route
  }
  func unpair(_ node: PairedHost) async throws {
    _ = try await hello(node.host)
    let (r, _) = try await request(UnpairResponse.self, Wire.unpair, "POST", token: node.token)
    guard r.value.ok else { throw LinkError.response }
  }
}
