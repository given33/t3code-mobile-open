import SwiftUI
import T3MobileCore

@main struct T3MobileApp: App {
  @StateObject private var model = AppModel()
  var body: some Scene { WindowGroup { HomeScreen(model: model) } }
}
private enum Panel: String, Identifiable {
  case pair, details, voice
  var id: String { rawValue }
}
private struct HomeScreen: View {
  @ObservedObject var model: AppModel
  @Environment(\.scenePhase) private var phase
  @State private var panel: Panel?
  @State private var cover = false
  @State private var voiceID = UUID()
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button {
          model.browser?.sidebar()
        } label: {
          Image(systemName: "sidebar.left")
        }.accessibilityLabel("切换网页侧栏").disabled(!model.ready)
        Spacer()
        deviceMenu
        Spacer()
        Button {
          voiceID = model.session?.id ?? UUID()
          panel = .voice
        } label: {
          Image(systemName: "waveform")
        }.accessibilityLabel("设备听写").disabled(!model.ready)
        Button {
          panel = .details
        } label: {
          Image(systemName: "slider.horizontal.3")
        }.accessibilityLabel("连接设置")
      }.font(.title3).buttonStyle(.borderless).padding(.horizontal).frame(minHeight: 48)
      if let message = model.banner {
        HStack {
          Text(message).font(.footnote)
          Spacer()
          Button {
            model.banner = nil
          } label: {
            Image(systemName: "xmark")
          }.accessibilityLabel("关闭提示")
        }.padding(8).background(.thinMaterial)
      }
      Divider()
      ZStack {
        Color(uiColor: Theme.surface(model.bgBase, dark: model.dark))
        if let session = model.session {
          OfficialWebView(model: model, session: session).id(session.id)
        }
        if model.selected != nil && (!model.ready || cover) {
          if let frame = model.resumeFrame {
            GeometryReader { geo in
              Image(uiImage: frame).resizable().scaledToFill().frame(
                width: geo.size.width, height: geo.size.height
              ).clipped()
            }.allowsHitTesting(false).accessibilityHidden(true)
          } else {
            Color("LaunchSurface")
          }
          if !cover {
            VStack(spacing: 10) {
              ProgressView()
              Text("正在连接「\(model.selected?.host.name ?? "主机")」…")
              Button("立即重试") { model.retry() }
            }.padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
          }
        } else if model.selected == nil {
          ContentUnavailableView {
            Label("连接你的 T3 主机", systemImage: "link")
          } description: {
            Text("在宿主插件面板打开 Mobile Link，然后扫描二维码或粘贴链接。")
          } actions: {
            Button("配对主机") { panel = .pair }.buttonStyle(.borderedProminent)
          }
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }.ignoresSafeArea(.keyboard, edges: .bottom).preferredColorScheme(
      model.dark.map { $0 ? .dark : .light }
    )
    .onAppear { model.foreground() }
    .onChange(of: phase) { _, p in
      switch p {
      case .active:
        cover = false
        model.foreground()
      case .inactive:
        model.browser?.captureFrame()
        cover = true
      case .background:
        model.background()
        cover = true
        if panel == .voice { panel = nil }
      @unknown default: break
      }
    }
    .onOpenURL { url in
      do {
        try model.parse(url.absoluteString)
        panel = .pair
      } catch { model.error = error.localizedDescription }
    }
    .sheet(item: $panel) { p in
      switch p {
      case .pair: PairingView(model: model)
      case .details: Details(model: model)
      case .voice: DictationSheet(model: model, sessionID: voiceID)
      }
    }
    .alert(
      "连接提示",
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button("好") { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
  }
  private func light(_ h: NodeHealth?) -> Color {
    guard let h else { return .yellow }
    guard let p = h.probe else { return .red }
    return p.upstreamOk ? .green : .yellow
  }
  private var deviceMenu: some View {
    Menu {
      Section("当前主机与 Family") {
        ForEach(model.familyNodes, id: \.host.id) { h in
          Button {
            model.select(h)
          } label: {
            Label(
              (h.host.role == .local ? "本机" : "云端") + " · " + h.host.name + " · "
                + (model.health[h.host.id]?.label ?? "探测中"),
              systemImage: h.host.id == model.selectedID ? "checkmark.circle" : "circle")
          }.disabled(
            h.host.id != model.selectedID && model.health[h.host.id]?.probe?.upstreamOk != true)
        }
      }
      Toggle("断线无感自动切换", isOn: $model.autoFailoverEnabled)
      if !model.otherNodes.isEmpty {
        Section("其他已配对主机") {
          ForEach(model.otherNodes, id: \.host.id) { h in
            Button(h.host.name) { model.select(h, asAnchor: true) }
          }
        }
      }
      Button("配对新主机", systemImage: "qrcode.viewfinder") { panel = .pair }
    } label: {
      HStack(spacing: 6) {
        Circle().fill(light(model.health[model.selectedID])).frame(width: 9, height: 9)
        VStack(alignment: .leading, spacing: 1) {
          Text(model.selected?.host.name ?? "未连接").font(.subheadline.bold()).lineLimit(1)
          if model.selected != nil {
            Text(model.health[model.selectedID]?.label ?? "探测中").font(.caption2)
          }
        }
        Image(systemName: "chevron.down").font(.caption)
      }.padding(.horizontal, 12).padding(.vertical, 5).background(.thinMaterial, in: Capsule())
    }
  }
}
private struct Details: View {
  @ObservedObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var confirm = false
  @State private var message: String?
  @State private var busy = false
  var body: some View {
    NavigationStack {
      Form {
        if let node = model.selected {
          Section("当前连接") {
            LabeledContent("主机", value: node.host.name)
            LabeledContent("状态", value: model.health[node.host.id]?.label ?? "尚未探测")
            LabeledContent("安全码", value: Fingerprint.safetyCode(node.fingerprint) ?? "无效")
            if let session = model.session {
              LabeledContent("地址", value: session.endpoint.authority)
              LabeledContent("操作", value: session.actions ? "可写" : "只读")
              LabeledContent("终端", value: session.terminal ? "启用" : "关闭")
            }
          }
          Toggle("断线无感自动切换", isOn: $model.autoFailoverEnabled)
          Button("重新探测") { model.retry() }
          Button("管理配对…", role: .destructive) { confirm = true }.disabled(busy)
            .confirmationDialog("撤销仅作用于当前主机，Family 对端须单独撤销。", isPresented: $confirm) {
              Button("在主机撤销此设备", role: .destructive) {
                busy = true
                Task {
                  defer { busy = false }
                  do {
                    try await model.unpair()
                    dismiss()
                  } catch { message = error.localizedDescription }
                }
              }
              if model.hosts.contains(where: { $0.host.id == node.host.id }) {
                Button("仅从此设备移除", role: .destructive) {
                  do {
                    try model.forget(node)
                    dismiss()
                  } catch { message = error.localizedDescription }
                }
              }
            }
        } else {
          Text("请先从设备菜单配对主机。")
        }
        if let message { Text(message).foregroundStyle(.red) }
      }.navigationTitle("连接设置").toolbar { Button("关闭") { dismiss() } }
    }
  }
}
