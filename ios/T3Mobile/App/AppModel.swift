import SwiftUI
import T3MobileCore
import WebKit

struct NodeHealth: Sendable {
  let confirmedLoss: Bool
  let probe: Probe?, sync: SyncResponse?
  var label: String {
    guard let probe else { return confirmedLoss ? "离线" : "未通过连接验证" }
    return (probe.upstreamOk ? "在线" : "上游离线") + " · \(probe.latencyMs) ms"
  }
}
@MainActor final class AppModel: ObservableObject {
  @Published private(set) var hosts: [PairedHost] = []
  @Published private(set) var selectedID = ""
  @Published private(set) var session: BrowserSession? {
    didSet { if session?.id != oldValue?.id { drawerOpen = false } }
  }
  @Published private(set) var drawerOpen = false
  @Published private(set) var health: [String: NodeHealth] = [:]
  @Published private(set) var ready = false
  @Published private(set) var resumeFrame: UIImage?
  @Published var banner: String?
  @Published var error: String?
  @Published var dark: Bool?
  @Published var bgBase = ""
  @Published var pendingPair: PairLink?
  @Published var autoFailoverEnabled = UserDefaults.standard.bool(forKey: "autoFailover") {
    didSet {
      UserDefaults.standard.set(autoFailoverEnabled, forKey: "autoFailover")
      policy = FailoverPolicy()
    }
  }
  weak var browser: OfficialWebView.Coordinator?
  private var anchorID = "", generation = UUID(), policy = FailoverPolicy(),
    poll: Task<Void, Never>?
  private var active = false, loaded = false, failures = 0, socket: SocketState?,
    retryAt: Double = 0
  private var webDeadline: Double = 0
  private var now: Double { ProcessInfo.processInfo.systemUptime }
  private var anchor: PairedHost? { hosts.first { $0.host.id == anchorID } }
  var familyNodes: [PairedHost] {
    guard let a = anchor else { return [] }
    guard let f = a.family, (try? f.validated(for: a.host)) != nil else { return [a] }
    let p = f.peer
    if let own = hosts.first(where: { $0.host.id == p.id }) {
      return own.fingerprint == p.fingerprint && own.host.role == p.role ? [a, own] : [a]
    }
    // Only the anchor's explicitly advertised peer may receive its grant. Never follow a peer-of-a-peer.
    return [
      a,
      PairedHost(
        host: HostIdentity(id: p.id, name: p.displayName, role: p.role), hosts: p.hosts,
        fingerprint: p.fingerprint, deviceId: a.deviceId, token: a.token, family: nil),
    ]
  }
  var selected: PairedHost? { familyNodes.first { $0.host.id == selectedID } }
  var otherNodes: [PairedHost] {
    hosts.filter { h in !familyNodes.contains { $0.host.id == h.host.id } }
  }
  func foreground() {
    active = true
    if !loaded {
      do {
        hosts = try KeychainStore.load()
        loaded = true
      } catch {
        self.error = "无法读取钥匙串，请解锁后重试。"
        return
      }
      let last = UserDefaults.standard.string(forKey: "anchor")
      anchorID = (hosts.first { $0.host.id == last } ?? hosts.first)?.host.id ?? ""
      let preferred = UserDefaults.standard.string(forKey: "selected")
      selectedID = (familyNodes.first { $0.host.id == preferred } ?? anchor)?.host.id ?? ""
      restoreCover()
    }
    restart()
  }
  func background() {
    active = false
    generation = UUID()
    poll?.cancel()
    browser?.captureFrame()
  }
  func retry() {
    if !loaded {
      foreground()
      return
    }
    failures = 0
    retryAt = 0
    restart()
  }
  func parse(_ text: String) throws {
    pendingPair = try PairLink(text.trimmingCharacters(in: .whitespacesAndNewlines))
  }
  func pair(_ link: PairLink) async throws {
    guard loaded else { throw LinkError.response }
    let attempts = await withTaskGroup(of: (Int, Probe?, String?).self) { group in
      for (index, e) in link.endpoints.enumerated() {
        group.addTask {
          let t = PinnedTransport(e, pin: link.pin)
          defer { t.close() }
          do {
            let hello = try await t.hello(link.host)
            return (index, Probe(endpoint: e, latencyMs: hello.latencyMs, upstreamOk: true), nil)
          } catch { return (index, nil, Self.diagnostic(error, at: e)) }
        }
      }
      var result: [(Int, Probe?, String?)] = []
      for await attempt in group { result.append(attempt) }
      return result.sorted { $0.0 < $1.0 }
    }
    guard let e = Probe.preferred(attempts.compactMap { $0.1 })?.endpoint else {
      throw LinkError.probes(attempts.compactMap { $0.2 })
    }
    let t = PinnedTransport(e, pin: link.pin)
    defer { t.close() }
    let node: PairedHost
    do { node = try await t.pair(link, name: UIDevice.current.model) }
    catch { throw LinkError.probes([Self.diagnostic(error, at: e)]) }
    let next = hosts.filter { $0.host.id != node.host.id } + [node]
    try KeychainStore.save(next)
    hosts = next
    pendingPair = nil
    select(node, asAnchor: true)
  }
  private nonisolated static func diagnostic(_ error: Error, at endpoint: Endpoint) -> String {
    let e = error as NSError
    let hint: String
    switch (e.domain, e.code) {
    case (NSURLErrorDomain, NSURLErrorNotConnectedToInternet), (NSURLErrorDomain, NSURLErrorDataNotAllowed):
      hint = "检查当前网络，并在 iOS 设置中允许此 App 使用「本地网络」。"
    case (NSURLErrorDomain, NSURLErrorTimedOut), (NSURLErrorDomain, NSURLErrorCannotConnectToHost):
      hint = "检查宿主监听端口、防火墙，以及 iOS「本地网络」权限。"
    case (NSURLErrorDomain, NSURLErrorCannotFindHost), (NSURLErrorDomain, NSURLErrorDNSLookupFailed):
      hint = "检查主机名和 DNS。"
    case (NSURLErrorDomain, NSURLErrorAppTransportSecurityRequiresSecureConnection), (NSURLErrorDomain, -1206 ... -1200):
      hint = "检查 TLS 证书有效期、系统时间与 ATS 配置。"
    default: hint = ""
    }
    return "\(endpoint.authority) — \(e.localizedDescription) [\(e.domain) \(e.code)] \(hint)"
  }
  private var checkpoint: (hostID: String, endpoint: Endpoint, request: HandoffRequest)?
  private var pendingClaim: (hostID: String, request: HandoffRequest, until: Double, inboxShown: Bool)?
  private var switching = false
  func select(_ node: PairedHost, asAnchor: Bool = false, automatic: Bool = false) {
    guard !switching else { return }
    guard !asAnchor, let from = selected, from.host.id != node.host.id,
      familyNodes.contains(where: { $0.host.id == node.host.id && $0.fingerprint == node.fingerprint }),
      let c = checkpoint, c.hostID == from.host.id, c.request.targetRole == node.host.role
    else {
      finishSwitch(node, asAnchor: asAnchor)
      if automatic { banner = "已自动切换到「\(node.host.name)」。" }
      return
    }
    switching = true
    let key = generation
    Task {
      defer { switching = false }
      let t = PinnedTransport(c.endpoint, pin: from.fingerprint)
      defer { t.close() }
      let offered = try? await t.handoff(from, c.request)
      guard generation == key, selectedID == from.host.id, active,
        familyNodes.contains(where: { $0.host.id == node.host.id && $0.fingerprint == node.fingerprint })
      else { return }
      let route = offered.flatMap { Wire.handoffRoute($0, environment: health[node.host.id]?.sync?.environmentId) }
      if let route {
        let store = BrowserSession.storeID(node.host.id, node.fingerprint)
        UserDefaults.standard.set(route, forKey: "route." + store.uuidString)
      }
      finishSwitch(node, asAnchor: false)
      let inbox = route?.hasPrefix("/relay-inbox/") == true
      if route == nil || inbox { pendingClaim = (node.host.id, c.request, now + 90, inbox) }
      if route == nil { banner = "已切换；未确认交接，请检查目标收件箱，不要重放未回执操作。" }
      else { banner = inbox ? "已切换到交接收件箱。" : "已切换到续跑线程。" }
    }
  }
  private func finishSwitch(_ node: PairedHost, asAnchor: Bool) {
    checkpoint = nil
    pendingClaim = nil
    if asAnchor || !familyNodes.contains(where: { $0.host.id == node.host.id }) {
      anchorID = node.host.id
    }
    selectedID = node.host.id
    UserDefaults.standard.set(anchorID, forKey: "anchor")
    UserDefaults.standard.set(selectedID, forKey: "selected")
    session = nil
    ready = false
    socket = nil
    retryAt = 0
    failures = 0
    dark = nil
    bgBase = ""
    banner = nil
    restoreCover()
    policy.switched(at: now)
    restart()
  }
  private func restart() {
    poll?.cancel()
    let key = UUID()
    generation = key
    guard active, selected != nil else { return }
    poll = Task { [weak self] in
      while !Task.isCancelled, let self, self.generation == key {
        await self.round(key)
        try? await Task.sleep(
          for: .seconds(self.failures == 0 ? 6 : min(24, 2 << min(self.failures, 4))))
      }
    }
  }
  nonisolated private static func sample(_ node: PairedHost, keeping activeEndpoint: Endpoint?)
    async -> NodeHealth
  {
    await withTaskGroup(of: NodeHealth.self) { group in
      for raw in Set(node.hosts) {
        group.addTask {
          do {
            let e = try Endpoint(raw)
            let t = PinnedTransport(e, pin: node.fingerprint)
            defer { t.close() }
            let r = try await t.sync(node)
            return NodeHealth(
              confirmedLoss: !r.value.upstreamOk,
              probe: Probe(endpoint: e, latencyMs: r.latencyMs, upstreamOk: r.value.upstreamOk),
              sync: r.value)
          } catch {
            let offline: Set<URLError.Code> = [
              .notConnectedToInternet, .timedOut, .cannotFindHost,
              .dnsLookupFailed, .networkConnectionLost, .cannotConnectToHost,
            ]
            let lost = (error as? URLError).map { offline.contains($0.code) } ?? false
            return NodeHealth(confirmedLoss: lost, probe: nil, sync: nil)
          }
        }
      }
      var results: [NodeHealth] = []
      for await result in group { results.append(result) }
      let best = Probe.preferred(results.compactMap(\.probe))
      // Preserve a healthy browser when two equivalent paths trade places in an RTT sample.
      if let live = results.first(where: {
        $0.probe?.endpoint == activeEndpoint && $0.probe?.upstreamOk == true
          && $0.probe?.endpoint.isLAN == best?.endpoint.isLAN
      }) {
        return live
      }
      let value = best.flatMap { best in results.first { $0.probe?.endpoint == best.endpoint } }
      return NodeHealth(
        confirmedLoss: !results.isEmpty && results.allSatisfy(\.confirmedLoss), probe: value?.probe,
        sync: value?.sync)
    }
  }
  private func round(_ key: UUID) async {
    guard let node = selected else { return }
    let members = familyNodes
    let samples = await withTaskGroup(of: (String, NodeHealth).self) { group in
      for h in members {
        let existing = session?.hostID == h.host.id ? session?.endpoint : nil
        group.addTask { (h.host.id, await Self.sample(h, keeping: existing)) }
      }
      var result: [String: NodeHealth] = [:]
      for await (id, s) in group { result[id] = s }
      return result
    }
    guard generation == key, !Task.isCancelled else { return }
    health = samples
    if let verified = samples[node.host.id]?.sync, !verified.actions || verified.relay?.enabled != true { checkpoint = nil }
    // Routes may be withdrawn or rotated. Never reuse an observation from before that change.
    if let a = anchor, let fresh = samples[a.host.id]?.sync, a.family != fresh.family {
      var next = hosts
      guard let i = next.firstIndex(where: { $0.host.id == a.host.id }) else { return }
      next[i].family = fresh.family
      do { try KeychainStore.save(next) } catch {
        self.error = "无法保存更新的 Family 路由。"
        session = nil
        return
      }
      hosts = next
      select(anchor ?? a, asAnchor: true)
      return
    }
    let current = samples[node.host.id]
    let peer = members.first { $0.host.id != node.host.id }
    if let peer {
      let remote = samples[peer.host.id]
      let same = reciprocal(remote?.sync, source: peer, opposite: node)
      if policy.shouldSwitch(
        autoFailoverEnabled: autoFailoverEnabled, current: current?.probe, peer: remote?.probe,
        sameFamily: same, confirmedLoss: current?.confirmedLoss == true, now: now)
      {
        select(peer, automatic: true)
        return
      }
    }
    guard let s = current?.sync, let probe = current?.probe, probe.upstreamOk else {
      failures = min(failures + 1, 6)
      if failures >= 2 || current?.confirmedLoss == false { invalidateSession() }
      return
    }
    if hosts.allSatisfy({ $0.host.id != node.host.id }), let a = anchor,
      !reciprocal(s, source: node, opposite: a)
    {
      invalidateSession()
      banner = "对端未确认同一 Family，已停止加载。"
      return
    }
    if let pending = pendingClaim, pending.hostID == node.host.id {
      if now > pending.until { pendingClaim = nil }
      else if s.relay?.enabled == true {
        let t = PinnedTransport(probe.endpoint, pin: node.fingerprint)
        defer { t.close() }
        let recovered = try? await t.claimedRoute(node, pending.request)
        guard generation == key, !Task.isCancelled else { return }
        if let recovered, Wire.handoffRoute(recovered, environment: s.environmentId) != nil {
          let routeKey = "route." + BrowserSession.storeID(node.host.id, node.fingerprint).uuidString
          let previous = UserDefaults.standard.string(forKey: routeKey)
          let inbox = recovered.hasPrefix("/relay-inbox/")
          if pending.inboxShown && previous != "/relay-inbox/" + pending.request.handoffId {
            pendingClaim = nil // The user has navigated away; do not take over the WebView again.
          } else {
            pendingClaim = inbox ? (node.host.id, pending.request, pending.until, true) : nil
            if previous != recovered {
              UserDefaults.standard.set(recovered, forKey: routeKey)
              invalidateSession()
              banner = "目标主机已领取检查点；请先核对未回执的操作。"
            }
          }
        }
      }
    }
    if let session, session.endpoint == probe.endpoint, session.actions == s.actions,
      session.terminal == s.terminal,
      session.expiresAt.timeIntervalSinceNow > 60
    {
      if !ready && now >= webDeadline {
        webFailed(session.id)
        return
      }
      failures = 0
      if socket == .disconnected { browser?.reconnect() }
      return
    }
    guard now >= retryAt else { return }
    let t = PinnedTransport(probe.endpoint, pin: node.fingerprint)
    defer { t.close() }
    do {
      let web = try await t.webSession(node)
      guard generation == key, !Task.isCancelled else { return }
      guard web.family == s.family else {
        invalidateSession()
        return
      }
      webDeadline = now + 25
      session = web
      ready = false
      socket = nil
      failures = 0
    } catch {
      guard generation == key else { return }
      invalidateSession()
      failures = min(failures + 1, 6)
      banner = "暂时无法建立网页会话，将自动重试。"
    }
  }
  private func reciprocal(_ sync: SyncResponse?, source: PairedHost, opposite: PairedHost) -> Bool {
    guard let f = sync?.family, let id = anchor?.family?.familyId else { return false }
    return f.familyId == id && f.role == source.host.role && f.peer.id == opposite.host.id
      && f.peer.fingerprint == opposite.fingerprint && f.peer.role == opposite.host.role
  }
  private func invalidateSession() {
    session = nil
    ready = false
    socket = nil
  }
  func webFailed(_ id: UUID) {
    guard session?.id == id else { return }
    invalidateSession()
    retryAt = now + 2
  }
  func bridge(_ event: BridgeEvent, in id: UUID) {
    guard let session, session.id == id else { return }
    switch event {
    case .ready: ready = true
    case let .route(path, title):
      if let path = Wire.route(path) {
        UserDefaults.standard.set(path, forKey: "route." + session.storeID.uuidString)
        guard let node = selected, let sync = health[node.host.id]?.sync, session.actions, sync.actions,
          let relay = sync.relay, relay.enabled, relay.role == node.host.role,
          let peer = familyNodes.first(where: { $0.host.id != node.host.id }), relay.peerRole == peer.host.role,
          let thread = Wire.threadID(path, environment: sync.environmentId) else { checkpoint = nil; return }
        if checkpoint?.hostID == node.host.id && checkpoint?.request.threadId == thread { return }
        // Stable across reloading the same host/thread, without persisting its title or token.
        let key = "handoff." + session.storeID.uuidString + "." + thread
        let id = UserDefaults.standard.string(forKey: key) ?? UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        let request = HandoffRequest(id: id, thread: thread, title: String(title.prefix(96)), to: peer.host.role)
        checkpoint = (node.host.id, session.endpoint, request)
        Task {
          let t = PinnedTransport(session.endpoint, pin: node.fingerprint)
          defer { t.close() }
          try? await t.checkpoint(node, request)
        }
      }
    case let .theme(dark, base):
      self.dark = dark
      bgBase = base
    case let .ui(open): drawerOpen = open
    case let .ws(state): socket = state
    case .authExpired: webFailed(id)
    }
  }
  func route(_ s: BrowserSession) -> String {
    Wire.route(UserDefaults.standard.string(forKey: "route." + s.storeID.uuidString) ?? "/") ?? "/"
  }
  private func coverURL(_ id: UUID) -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(
      "frame-" + id.uuidString + ".jpg")
  }
  private func restoreCover() {
    guard let selected else {
      resumeFrame = nil
      return
    }
    let url = coverURL(BrowserSession.storeID(selected.host.id, selected.fingerprint))
    resumeFrame = UIImage(contentsOfFile: url.path)
  }
  func saveFrame(_ image: UIImage, session s: BrowserSession) {
    guard session?.id == s.id else { return }
    resumeFrame = image
    try? image.jpegData(compressionQuality: 0.75)?.write(
      to: coverURL(s.storeID), options: [.atomic, .completeFileProtection])
  }
  func unpair() async throws {
    guard let node = selected, let e = health[selectedID]?.probe?.endpoint else {
      throw LinkError.noEndpoint
    }
    let t = PinnedTransport(e, pin: node.fingerprint)
    defer { t.close() }
    try await t.unpair(node)
    try forget(node)
  }
  func forget(_ node: PairedHost) throws {
    let next = hosts.filter { $0.host.id != node.host.id }
    try KeychainStore.save(next)
    let affected =
      node.host.id == anchorID
      ? familyNodes.filter { h in !next.contains { $0.host.id == h.host.id } } : [node]
    hosts = next
    invalidateSession()
    resumeFrame = nil
    banner = nil
    generation = UUID()
    poll?.cancel()
    for h in affected {
      let id = BrowserSession.storeID(h.host.id, h.fingerprint)
      UserDefaults.standard.removeObject(forKey: "route." + id.uuidString)
      try? FileManager.default.removeItem(at: coverURL(id))
      Task {
        // removeData also works while SwiftUI is still dismantling the old web view.
        await WKWebsiteDataStore(forIdentifier: id).removeData(
          ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
      }
    }
    if let first = hosts.first {
      select(first, asAnchor: true)
    } else {
      selectedID = ""
      anchorID = ""
      health = [:]
    }
  }
}
