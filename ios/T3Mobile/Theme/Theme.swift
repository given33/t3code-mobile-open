import SwiftUI
import UIKit

enum Theme {
  static func hex(_ css: String, dark: Bool?) -> String {
    let s = css.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.range(of: #"^#[0-9a-fA-F]{6}$"#, options: .regularExpression) != nil { return s }
    return (dark ?? (UITraitCollection.current.userInterfaceStyle == .dark)) ? "#15171B" : "#F5F6F8"
  }
  static func surface(_ css: String, dark: Bool?) -> UIColor {
    let n = Int(hex(css, dark: dark).dropFirst(), radix: 16) ?? 0
    return UIColor(
      red: CGFloat(n >> 16) / 255, green: CGFloat(n >> 8 & 255) / 255, blue: CGFloat(n & 255) / 255,
      alpha: 1)
  }
}
