import Foundation

public enum Wire {
  public static let hello = "/mobile/v1/hello", pair = "/mobile/v1/pair",
    webSession = "/mobile/v1/web-session"
  public static let sync = "/mobile/v1/sync", unpair = "/mobile/v1/unpair", cookie = "t3m_session",
    handler = "t3Mobile"
  public static let relayStatus = "/mobile/v1/relay/status", handoff = "/mobile/v1/relay/handoff",
    checkpoint = "/mobile/v1/relay/checkpoint", claims = "/mobile/v1/relay/claims/"
  public static func threadID(_ path: String, environment: String) -> String? {
    guard route(path) == path else { return nil }
    let parts = path.split(separator: "/").map(String.init)
    guard let id = parts.last, id.range(of: #"\A[A-Za-z0-9][A-Za-z0-9_-]{0,95}\z"#, options: .regularExpression) != nil else { return nil }
    if parts.count == 2 && [environment, "thread", "threads"].contains(parts[0]) { return id }
    if parts.count == 3 && parts[1] == environment && ["threads", "_chat"].contains(parts[0]) { return id }
    if parts.count == 3 && parts[0] == environment && parts[1] == "threads" { return id }
    if parts.count == 1 && UUID(uuidString: id) != nil { return id }
    return nil
  }
  /// Only accept a native handoff route on the pinned destination's own environment.
  public static func handoffRoute(_ path: String, environment: String?) -> String? {
    guard route(path) == path else { return nil }
    if path.hasPrefix("/relay-inbox/") { return path }
    guard let environment, let thread = threadID(path, environment: environment),
      path == "/" + environment + "/" + thread else { return nil }
    return path
  }
  public static func validSecret(_ value: String) -> Bool {
    value.range(of: #"\A[A-Za-z0-9_-]{43}\z"#, options: .regularExpression) != nil
  }
  /// Persist only application pathnames; no fragment, query, encoded separators or dot segments.
  public static func route(_ path: String) -> String? {
    guard path.utf8.count <= 2048, path.hasPrefix("/"), !path.contains("//"), !path.contains("?"),
      !path.contains("#"),
      path.range(of: "%2f", options: .caseInsensitive) == nil,
      let plain = path.removingPercentEncoding, !plain.contains("\\"), !plain.contains("%"),
      !plain.contains("//"), !plain.contains("?"), !plain.contains("#"),
      plain.rangeOfCharacter(from: .controlCharacters) == nil
    else { return nil }
    let parts = plain.split(separator: "/")
    guard !parts.contains(".."), !parts.contains("."),
      !["api", "assets", "attachments", "mobile", "ws", ".well-known"].contains(parts.first ?? "")
    else { return nil }
    return path
  }
}
public struct HelloResponse: Codable, Sendable {
  public let `protocol`: Int, backend, appVersion: String, host: HostIdentity, fingerprint: String
  public func verify(_ expected: HostIdentity, pin: String) throws {
    guard `protocol` == 1, backend == "t3code", host.id == expected.id, host.role == expected.role,
      fingerprint == pin
    else { throw PairError.identity }
  }
}
public struct PairRequest: Codable {
  public let code, name: String
  public init(code: String, name: String) {
    self.code = code
    self.name = name
  }
}
public protocol HostMetadata {
  var host: HostIdentity { get }
  var family: FamilyRoute? { get }
  var actions: Bool { get }
  var terminal: Bool { get }
}
extension HostMetadata {
  public func verify(_ expected: HostIdentity) throws {
    guard host.id == expected.id, host.role == expected.role, actions || !terminal else {
      throw PairError.identity
    }
    _ = try family?.validated(for: host)
  }
}
public struct PairResponse: Codable, HostMetadata, Sendable {
  public let host: HostIdentity, actions, terminal: Bool, family: FamilyRoute?, deviceId,
    token: String
}
public struct WebSessionResponse: Codable, HostMetadata, Sendable {
  public let host: HostIdentity, actions, terminal: Bool, family: FamilyRoute?, cookieName: String
}
public struct SyncResponse: Codable, HostMetadata, Sendable {
  public let host: HostIdentity, actions, terminal: Bool, family: FamilyRoute?, ok,
    upstreamOk: Bool, environmentId: String, serverTimeMs: Int64
  public let relay: RelayStatusResponse?
}
public struct RelayStatusResponse: Codable, Sendable {
  public let targetRoute, targetThreadId: String?, sourceInterrupted, nativeContinued: Bool?
  public struct Workspace: Codable, Sendable { public let projectKey, status: String, rev: String? }
  public let enabled: Bool, role, peerRole: HostRole?, leaseState: String,
    syncedWorkspaces: [Workspace], activeHandoff: String?, conflicts: Int, lastSyncAt: Int64?
}
public struct HandoffRequest: Codable, Sendable {
  public let handoffId, threadId, title: String, targetRole: HostRole
  public init(id: String, thread: String, title: String, to: HostRole) {
    handoffId = id; threadId = thread; self.title = title; targetRole = to
  }
}
public struct HandoffResponse: Codable, Sendable {
  public let ok: Bool, handoffId, status: String, targetRole: HostRole, targetRoute, sourceRevision: String?
  public let targetThreadId, environmentId: String?, sourceInterrupted, nativeContinued: Bool?
  public func route(for request: HandoffRequest) -> String? {
    guard ok, status == "claimed", handoffId == request.handoffId, targetRole == request.targetRole,
      let route = targetRoute, Wire.route(route) == route else { return nil }
    if nativeContinued != true { return route == "/relay-inbox/" + handoffId ? route : nil }
    guard let env = environmentId, let thread = targetThreadId,
      [env, thread].allSatisfy({ $0.range(of: #"\A[A-Za-z0-9][A-Za-z0-9_-]{0,95}\z"#, options: .regularExpression) != nil }),
      route == "/" + env + "/" + thread else { return nil }
    return route
  }
}
public struct CheckpointResponse: Codable, Sendable { public let ok: Bool, handoffId: String }
public struct UnpairResponse: Codable { public let ok: Bool }
public enum SocketState: String, Codable, Sendable { case connecting, connected, disconnected }
public enum BridgeEvent: Codable, Equatable {
  case ready, authExpired
  case route(pathname: String, title: String)
  case theme(dark: Bool, bgBase: String)
  case ws(SocketState)
  private enum Keys: String, CodingKey { case type, pathname, title, dark, bgBase, state }
  private enum Kind: String, Codable { case ready, route, theme, ws, authExpired = "auth-expired" }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(Kind.self, forKey: .type) {
    case .ready: self = .ready
    case .authExpired: self = .authExpired
    case .route:
      self = .route(
        pathname: try c.decode(String.self, forKey: .pathname),
        title: try c.decode(String.self, forKey: .title))
    case .theme:
      self = .theme(
        dark: try c.decode(Bool.self, forKey: .dark),
        bgBase: try c.decode(String.self, forKey: .bgBase))
    case .ws: self = .ws(try c.decode(SocketState.self, forKey: .state))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    let kind: Kind
    switch self {
    case .ready: kind = .ready
    case .authExpired: kind = .authExpired
    case let .route(path, title):
      kind = .route
      try c.encode(path, forKey: .pathname)
      try c.encode(title, forKey: .title)
    case let .theme(dark, bg):
      kind = .theme
      try c.encode(dark, forKey: .dark)
      try c.encode(bg, forKey: .bgBase)
    case let .ws(state):
      kind = .ws
      try c.encode(state, forKey: .state)
    }
    try c.encode(kind, forKey: .type)
  }
}
