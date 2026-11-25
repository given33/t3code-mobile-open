import XCTest

@testable import T3MobileCore

final class PairingTests: XCTestCase {
  let uri =
    "t3mobile://pair?v=1&id=node&name=Desk+%2B+Phone&role=local&pin=XNJS-wzokyQ2-vjM0QQJgbie5K1rn-niorfnGqyyfNM&code=abcdefghijklmnopqrstuvwx&hosts=example.com%3A3081%2C%5B%3A%3A1%5D%3A443"
  func testFormAndOrigins() throws {
    let p = try PairLink(uri)
    XCTAssertEqual(p.host.name, "Desk + Phone")
    XCTAssertEqual(p.endpoints.map(\.authority), ["example.com:3081", "[::1]"])
    XCTAssertTrue(p.endpoints[1].isLAN)
    XCTAssertTrue(
      try Endpoint("https://EXAMPLE.com:443/").matches(URL(string: "https://example.com/path")))
    XCTAssertFalse(p.endpoints[0].matches(URL(string: "https://example.com")))
  }
  func testRejectAmbiguity() {
    for s in [
      uri + "&v=1", uri + "#frag", uri.replacingOccurrences(of: "v=1", with: "v=2"),
      uri.replacingOccurrences(of: "pin=X", with: "pin=="),
      uri.replacingOccurrences(of: "code=a", with: "code="),
    ] { XCTAssertThrowsError(try PairLink(s)) }
    for s in [
      "http://example.com", "user@example.com", "example.com:65536", "example.com/a",
      "example.com?", "example.com#", "example.com%2Fa", "",
    ] { XCTAssertThrowsError(try Endpoint(s), s) }
    for p in [
      "//example.com", "/a/../b", "/api/session", "/a%5cb", "/%2fexample.test", "/x?q",
      "/assets/test.html",
    ] { XCTAssertNil(Wire.route(p)) }
  }
}
