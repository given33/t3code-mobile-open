import XCTest

@testable import T3MobileCore

func fixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
  let u = try XCTUnwrap(
    Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder().decode(type, from: Data(contentsOf: u))
}
final class ProtocolTypesTests: XCTestCase {
  func testCapturedExchange() throws {
    let hello = try fixture(HelloResponse.self, "hello")
    let pair = try fixture(PairResponse.self, "pair")
    let web = try fixture(WebSessionResponse.self, "web-session")
    let sync = try fixture(SyncResponse.self, "sync")
    try hello.verify(pair.host, pin: hello.fingerprint)
    try pair.verify(hello.host)
    try web.verify(pair.host)
    try sync.verify(pair.host)
    XCTAssertThrowsError(try hello.verify(hello.host, pin: "other"))
    XCTAssertTrue(sync.ok && sync.upstreamOk)
    XCTAssertEqual(sync.family?.peer.displayName, "Cloud")
    XCTAssertEqual(web.cookieName, Wire.cookie)
    XCTAssertTrue(Wire.validSecret(pair.token))
    XCTAssertEqual(sync.environmentId, "test-env")
    let req =
      try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(PairRequest(code: "sample", name: "Phone"))) as? [String: String]
    XCTAssertEqual(req, ["code": "sample", "name": "Phone"])
  }
  func testBridge() throws {
    let d = JSONDecoder()
    let events = try fixture([BridgeEvent].self, "events")
    XCTAssertEqual(
      events,
      [
        .ready, .route(pathname: "/thread", title: "Thread"), .theme(dark: true, bgBase: "#222222"),
        .ws(.connecting), .ws(.connected), .ws(.disconnected), .authExpired,
      ])
    XCTAssertEqual(try d.decode([BridgeEvent].self, from: JSONEncoder().encode(events)), events)
    for s in [
      #"{"type":"ws","state":"up"}"#, #"{"type":"theme","dark":true}"#, #"{"type":"unknown"}"#,
    ] {
      XCTAssertThrowsError(try d.decode(BridgeEvent.self, from: Data(s.utf8)))
    }
  }
}
extension ProtocolTypesTests {
  func testRelayCompatibilityAndBoundRoute() throws {
    let old = try fixture(SyncResponse.self, "sync")
    XCTAssertNil(old.relay)
    let relay = try fixture(RelayStatusResponse.self, "relay")
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
    json["relay"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(relay))
    let sync = try JSONDecoder().decode(SyncResponse.self, from: JSONSerialization.data(withJSONObject: json))
    XCTAssertTrue(sync.relay?.enabled == true)
    XCTAssertEqual(sync.relay?.role, .local)
    let h = try fixture(HandoffResponse.self, "handoff")
    func request(_ id: String, _ role: HostRole) -> HandoffRequest { .init(id: id, thread: "thread-one", title: "", to: role) }
    XCTAssertEqual(h.route(for: request("test-request", .cloud)), "/relay-inbox/test-request")
    func native(_ route: String) throws -> HandoffResponse {
      let json: [String: Any] = ["ok":true, "status":"claimed", "targetRole":"cloud", "handoffId":"test-request", "targetThreadId":"thread-two", "environmentId":"env-two", "nativeContinued":true, "targetRoute":route]
      return try JSONDecoder().decode(HandoffResponse.self, from: JSONSerialization.data(withJSONObject: json))
    }
    XCTAssertEqual(try native("/env-two/thread-two").route(for: request("test-request", .cloud)), "/env-two/thread-two")
    for bad in ["//env-two/thread-two", "/env-two/other", "/other/thread-two", "/env-two/%2f", "/api/thread-two"] {
      XCTAssertNil(try native(bad).route(for: request("test-request", .cloud)))
    }
    XCTAssertEqual(Wire.handoffRoute("/env-two/thread-two", environment: "env-two"), "/env-two/thread-two")
    XCTAssertNil(Wire.handoffRoute("/env-two/thread-two", environment: "unexpected"))
    XCTAssertNil(Wire.handoffRoute("/env-two/thread-two", environment: nil))
    XCTAssertNil(h.route(for: request("other", .cloud)))
    XCTAssertNil(h.route(for: request("test-request", .local)))
    XCTAssertEqual(Wire.threadID("/test-env/thread-one", environment: "test-env"), "thread-one")
    for path in ["/threads/test-env/thread-one", "/_chat/test-env/thread-one"] {
      XCTAssertEqual(Wire.threadID(path, environment: "test-env"), "thread-one")
    }
    XCTAssertNil(Wire.threadID("/threads/other-env/thread-one", environment: "test-env"))
    for path in ["/", "/settings/plugins", "/api/abc", "/relay-inbox/test-request", "/thread/%2F", "/thread/../bad"] {
      XCTAssertNil(Wire.threadID(path, environment: "test-env"))
    }
  }
}
