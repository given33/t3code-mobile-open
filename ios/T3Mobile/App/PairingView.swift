import SwiftUI
import T3MobileCore

struct PairingView: View {
  @ObservedObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var scan = false
  @State private var busy = false
  @State private var message: String?
  var body: some View {
    NavigationStack {
      Form {
        if let candidate = model.pendingPair {
          Section("核对主机身份") {
            Text(candidate.host.name).font(.headline)
            Text(candidate.safetyCode).font(.system(.title2, design: .monospaced))
              .accessibilityLabel("安全码 " + candidate.safetyCode)
            Text("请与宿主面板显示的 16 位十六进制安全码逐组核对。仅在完全一致时继续。")
            Button("安全码一致，确认配对") {
              busy = true
              Task {
                defer { busy = false }
                do {
                  try await model.pair(candidate)
                  dismiss()
                } catch { message = error.localizedDescription }
              }
            }.disabled(busy)
            Button("不一致，取消", role: .cancel) {
              model.pendingPair = nil
              text = ""
            }.disabled(busy)
          }
        } else {
          Section("扫描宿主二维码") {
            if scan {
              QRCapture(
                scanned: {
                  scan = false
                  parse($0)
                },
                failed: {
                  scan = false
                  message = $0
                }
              ).frame(height: 220)
            }
            Button(scan ? "停止扫描" : "启动相机") { scan.toggle() }
          }
          Section("或粘贴配对链接") {
            TextField("t3mobile://pair?…", text: $text, axis: .vertical).autocorrectionDisabled()
              .textInputAutocapitalization(.never)
            Button("核对安全码") { parse(text) }.disabled(text.isEmpty)
          }
        }
        if busy { ProgressView("正在建立固定连接…") }
        if let message { Text(message).foregroundStyle(.red) }
      }.navigationTitle("配对主机").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(busy) }
      }
    }.interactiveDismissDisabled(busy).onDisappear { model.pendingPair = nil }
  }
  private func parse(_ value: String) {
    do {
      try model.parse(value)
      message = nil
      text = ""
    } catch { message = error.localizedDescription }
  }
}
