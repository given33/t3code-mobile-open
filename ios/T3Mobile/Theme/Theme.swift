import SwiftUI
import UIKit

enum Theme {
  static func hex(_ css: String, dark: Bool?) -> String {
    let s = css.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.range(of: #"^#[0-9a-fA-F]{6}$"#, options: .regularExpression) != nil { return s }
    if s.range(of: #"^#[0-9a-fA-F]{3}$"#, options: .regularExpression) != nil {
      return "#" + s.dropFirst().map { String(repeating: String($0), count: 2) }.joined()
    }
    if s.hasPrefix("rgb("), s.hasSuffix(")") {
      let fields = s.dropFirst(4).dropLast().split { $0 == "," || $0.isWhitespace }
      let values = fields.compactMap { Int($0) }
      if fields.count == 3, values.count == 3, values.allSatisfy({ (0...255).contains($0) }) {
        return "#" + values.map { String(format: "%02x", $0) }.joined()
      }
    }
    return (dark ?? (UITraitCollection.current.userInterfaceStyle == .dark)) ? "#15171B" : "#F5F6F8"
  }
  static func surface(_ css: String, dark: Bool?) -> UIColor {
    let n = Int(hex(css, dark: dark).dropFirst(), radix: 16) ?? 0
    return UIColor(
      red: CGFloat(n >> 16) / 255, green: CGFloat(n >> 8 & 255) / 255, blue: CGFloat(n & 255) / 255,
      alpha: 1)
  }
}
