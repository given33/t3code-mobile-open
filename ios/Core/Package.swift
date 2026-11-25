// swift-tools-version: 5.9
import PackageDescription

var targets: [Target] = []
var crypto: [Target.Dependency] = []
#if os(Linux)
  targets.append(
    .systemLibrary(name: "COpenSSL", pkgConfig: "libcrypto", providers: [.apt(["libssl-dev"])]))
  crypto = ["COpenSSL"]
#endif
targets += [
  .target(name: "T3MobileCore", dependencies: crypto),
  .testTarget(
    name: "T3MobileCoreTests", dependencies: ["T3MobileCore"], resources: [.copy("Fixtures")]),
]
let package = Package(
  name: "T3MobileCore", platforms: [.iOS(.v17), .macOS(.v12)],
  products: [.library(name: "T3MobileCore", targets: ["T3MobileCore"])], targets: targets)
