import Foundation

public struct Probe: Sendable {
  public let endpoint: Endpoint, latencyMs: Int, upstreamOk: Bool
  public init(endpoint: Endpoint, latencyMs: Int, upstreamOk: Bool) {
    self.endpoint = endpoint
    self.latencyMs = latencyMs
    self.upstreamOk = upstreamOk
  }
  public static func preferred(_ candidates: [Probe]) -> Probe? {
    candidates.sorted { a, b in
      if a.upstreamOk != b.upstreamOk { return a.upstreamOk }
      if a.endpoint.isLAN != b.endpoint.isLAN { return a.endpoint.isLAN }
      if a.latencyMs != b.latencyMs { return a.latencyMs < b.latencyMs }
      return a.endpoint.authority < b.endpoint.authority
    }.first
  }
}
public struct FailoverPolicy {
  private var failures = 0, cooldownUntil: TimeInterval = 0
  public init() {}
  public mutating func switched(at now: TimeInterval) {
    failures = 0
    cooldownUntil = now + 30
  }
  /// One observation per completed, non-overlapping poll of *all* endpoints.
  /// Missing sync alone is not proof of loss: never turn a pin/auth/protocol failure into an automatic switch.
  public mutating func shouldSwitch(
    autoFailoverEnabled: Bool, current: Probe?, peer: Probe?,
    sameFamily: Bool, confirmedLoss: Bool, now: TimeInterval
  ) -> Bool {
    guard autoFailoverEnabled, confirmedLoss, current?.upstreamOk != true else {
      failures = 0
      return false
    }
    failures = min(2, failures + 1)
    return failures >= 2 && sameFamily && peer?.upstreamOk == true && now >= cooldownUntil
  }
}
