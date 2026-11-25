import XCTest

@testable import T3MobileCore

final class FingerprintTests: XCTestCase {
  // SEC 2 P-256 generator (public point only); Node independently exports its JWK as DER.
  let point =
    "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
  let prefix = "3059301306072a8648ce3d020106082a8648ce3d030107034200"
  let pin = "XNJS-wzokyQ2-vjM0QQJgbie5K1rn-niorfnGqyyfNM"
  let safety = "5CD2 52FB 0CE8 9324"
  func testVector() throws {
    let raw = Data(
      stride(from: 0, to: point.count, by: 2).map {
        UInt8(point.dropFirst($0).prefix(2), radix: 16)!
      })
    let spki = try XCTUnwrap(Fingerprint.spki(rawPoint: raw))
    XCTAssertEqual(spki.map { String(format: "%02x", $0) }.joined(), prefix + point)
    XCTAssertEqual(Fingerprint.encode(Fingerprint.digest(spki)), pin)
    XCTAssertEqual(Fingerprint.safetyCode(pin), safety)
    XCTAssertNil(Fingerprint.spki(rawPoint: raw.dropFirst()))
    XCTAssertNil(Fingerprint.safetyCode(pin + "="))
  }
  func testPluginCertificateAndValidity() throws {
    let f = try fixture(CertificateFixture.self, "leaf")
    let der = try XCTUnwrap(Data(base64Encoded: f.der))
    let from = Date(timeIntervalSince1970: f.from)
    let until = Date(timeIntervalSince1970: f.until)
    XCTAssertEqual(Fingerprint.certificatePin(der, now: from), f.pin)
    XCTAssertNil(Fingerprint.certificatePin(der, now: from.addingTimeInterval(-1)))
    XCTAssertNil(Fingerprint.certificatePin(der, now: until))
    XCTAssertNil(Fingerprint.certificatePin(der.dropLast(), now: from))
  }
}
private struct CertificateFixture: Decodable {
  let der, pin: String
  let from, until: Double
}
