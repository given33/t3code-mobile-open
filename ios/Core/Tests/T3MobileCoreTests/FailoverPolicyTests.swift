import XCTest

@testable import T3MobileCore

final class FailoverPolicyTests: XCTestCase {
  func testDebounceGatesAndCooldown() throws {
    let e = try Endpoint("example.com")
    let up = Probe(endpoint: e, latencyMs: 5, upstreamOk: true)
    let down = Probe(endpoint: e, latencyMs: 1, upstreamOk: false)
    var p = FailoverPolicy()
    func check(
      _ t: Double, _ auto: Bool = true, _ current: Probe? = nil, _ peer: Probe? = nil,
      _ family: Bool = true, _ confirmed: Bool = true
    ) -> Bool {
      p.shouldSwitch(
        autoFailoverEnabled: auto, current: current, peer: peer, sameFamily: family,
        confirmedLoss: confirmed, now: t)
    }
    XCTAssertFalse(check(0, false, nil, up))
    XCTAssertFalse(check(0, true, nil, up, true, false))
    XCTAssertFalse(check(1, true, nil, up, true, false))
    XCTAssertFalse(check(1, true, nil, up))
    XCTAssertFalse(check(2, true, nil, down))
    XCTAssertFalse(check(3, true, nil, up, false))
    XCTAssertFalse(check(4, true, up, up))
    XCTAssertFalse(check(5, true, down, up))
    XCTAssertTrue(check(6, true, nil, up))
    p.switched(at: 6)
    XCTAssertFalse(check(7, true, nil, up))
    XCTAssertFalse(check(35, true, nil, up))
    XCTAssertTrue(check(36, true, nil, up))
  }
  func testEndpointSelection() throws {
    let lan = try Endpoint("10.0.0.1:3081")
    let wan = try Endpoint("example.com")
    let list = [
      Probe(endpoint: lan, latencyMs: 5, upstreamOk: false),
      Probe(endpoint: wan, latencyMs: 3, upstreamOk: true),
      Probe(endpoint: lan, latencyMs: 25, upstreamOk: true),
      Probe(endpoint: lan, latencyMs: 9, upstreamOk: true),
    ]
    XCTAssertEqual(Probe.preferred(list)?.latencyMs, 9)
    XCTAssertNil(Probe.preferred([]))
  }
}
