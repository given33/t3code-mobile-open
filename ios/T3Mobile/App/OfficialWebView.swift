import QuickLook
import SwiftUI
import T3MobileCore
import WebKit

@MainActor struct OfficialWebView: UIViewRepresentable {
  @ObservedObject var model: AppModel
  let session: BrowserSession
  func makeCoordinator() -> Coordinator { Coordinator(model, session) }
  func makeUIView(context: Context) -> WKWebView {
    let c = context.coordinator
    let config = WKWebViewConfiguration()
    config.websiteDataStore = WKWebsiteDataStore(forIdentifier: session.storeID)
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.userContentController.add(WeakScriptMessageHandler(c), name: Wire.handler)
    let args = [
      "origin": session.origin.absoluteString, "route": model.route(session),
      "bg": Theme.hex(model.bgBase, dark: model.dark),
    ]
    let json = String(decoding: (try? JSONEncoder().encode(args)) ?? Data("{}".utf8), as: UTF8.self)
    let script = """
      (() => {
        const v = \(json);
        if (location.origin !== v.origin) return;
        const root = document.documentElement;
        root?.setAttribute('data-t3m-native-nav', '');
        if (root) root.style.backgroundColor = v.bg;
        const key = 't3m-restored-this-session', session = '\(session.id.uuidString)';
        if (location.pathname === '/' && v.route !== '/' && sessionStorage.getItem(key) !== session) {
          sessionStorage.setItem(key, session);
          history.replaceState(null, '', v.route);
        }
      })();
      """
    config.userContentController.addUserScript(
      WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let view = WKWebView(frame: .zero, configuration: config)
    // iOS WebKit presents the system picker for HTML file inputs; do not override its open panel.
    view.navigationDelegate = c
    view.isOpaque = false
    view.scrollView.keyboardDismissMode = .interactive
    view.allowsLinkPreview = false
    view.underPageBackgroundColor = Theme.surface(model.bgBase, dark: model.dark)
    c.attach(view)
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    view.underPageBackgroundColor = Theme.surface(model.bgBase, dark: model.dark)
  }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    coordinator.detach(view)
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKDownloadDelegate,
    WKScriptMessageHandler, QLPreviewControllerDataSource, QLPreviewControllerDelegate
  {
    weak var model: AppModel?, view: WKWebView?
    let s: BrowserSession, policy: PinPolicy
    private var downloads: [ObjectIdentifier: URL] = [:], previewURL: URL?, boot: Task<Void, Never>?
    init(_ model: AppModel, _ s: BrowserSession) {
      self.model = model
      self.s = s
      policy = PinPolicy(endpoint: s.endpoint, fingerprint: s.fingerprint)
    }
    private var current: Bool { model?.session?.id == s.id }
    func attach(_ v: WKWebView) {
      view = v
      model?.browser = self
      for name in [
        UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification,
      ] {
        NotificationCenter.default.addObserver(
          self, selector: #selector(keyboard(_:)), name: name, object: nil)
      }
      boot = Task { [weak self, weak v] in
        guard let self, let v else { return }
        do {
          // Navigation delegates don't cover fetch/images. Block other network authorities,
          // including a different port on the cookie's own host, for all resource types.
          let escaped = NSRegularExpression.escapedPattern(for: s.endpoint.authority)
            .replacingOccurrences(of: "\\-", with: "-")
          let port = s.origin.port == nil ? "(:443)?" : ""
          var rules = [["trigger": ["url-filter": "^[a-z]+://"], "action": ["type": "block"]]]
          for scheme in ["https", "wss"] {
            rules.append([
              "trigger": ["url-filter": "^" + scheme + "://" + escaped + port + "/"],
              "action": ["type": "ignore-previous-rules"],
            ])
          }
          let supported = String(decoding: try JSONEncoder().encode(rules), as: UTF8.self)
          guard
            let list = try await WKContentRuleListStore.default().compileContentRuleList(
              forIdentifier: "origin-" + s.storeID.uuidString, encodedContentRuleList: supported),
            current, !Task.isCancelled
          else { return }
          v.configuration.userContentController.add(list)
          await v.configuration.websiteDataStore.httpCookieStore.setCookie(s.cookie)
          guard current, !Task.isCancelled else { return }
          let savedRoute = model?.route(s) ?? "/"
          let entry = savedRoute.hasPrefix("/relay-inbox/") ? savedRoute : "/"
          v.load(
            URLRequest(
              url: s.origin.appendingPathComponent(entry), cachePolicy: .reloadIgnoringLocalCacheData)
          )
        } catch { if current { model?.webFailed(s.id) } }
      }
    }
    func detach(_ v: WKWebView) {
      boot?.cancel()
      NotificationCenter.default.removeObserver(self)
      v.stopLoading()
      v.navigationDelegate = nil
      v.configuration.userContentController.removeScriptMessageHandler(forName: Wire.handler)
      if model?.browser === self { model?.browser = nil }
      view = nil
      if let previewURL {
        cleanup(previewURL)
        self.previewURL = nil
      }
      for url in downloads.values { cleanup(url) }
      downloads.removeAll()
    }
    private func trusted(_ v: WKWebView?) -> Bool {
      guard current, let v, v === view, s.endpoint.matches(v.url), let path = v.url?.path,
        Wire.route(path.isEmpty ? "/" : path) != nil, let trust = v.serverTrust
      else { return false }
      return policy.accepts(trust)
    }
    func userContentController(
      _ userContentController: WKUserContentController, didReceive m: WKScriptMessage
    ) {
      let o = m.frameInfo.securityOrigin
      guard m.name == Wire.handler, m.frameInfo.isMainFrame, trusted(m.webView),
        s.endpoint.matches(m.frameInfo.request.url),
        let framePath = m.frameInfo.request.url?.path,
        Wire.route(framePath.isEmpty ? "/" : framePath) != nil,
        o.protocol == "https",
        o.host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
          == s.origin.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
        (o.port == 0 ? 443 : o.port) == (s.origin.port ?? 443),
        JSONSerialization.isValidJSONObject(m.body),
        let data = try? JSONSerialization.data(withJSONObject: m.body), data.count <= 32768,
        let event = try? JSONDecoder().decode(BridgeEvent.self, from: data)
      else { return }
      model?.bridge(event, in: s.id)
    }
    func webView(
      _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      guard current else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      policy.answer(challenge, completionHandler)
    }
    func webView(
      _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      guard current, let u = action.request.url, s.endpoint.matches(u),
        action.targetFrame?.isMainFrame == true,
        action.sourceFrame.isMainFrame
      else {
        decisionHandler(.cancel)
        return
      }
      if action.shouldPerformDownload || Wire.route(u.path.isEmpty ? "/" : u.path) == nil {
        decisionHandler(
          action.navigationType == .linkActivated && trusted(webView) ? .download : .cancel)
      } else {
        decisionHandler(.allow)
      }
    }
    func webView(
      _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
      decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
      guard current, response.isForMainFrame, s.endpoint.matches(response.response.url),
        let http = response.response as? HTTPURLResponse
      else {
        decisionHandler(.cancel)
        return
      }
      guard (200..<300).contains(http.statusCode) else {
        decisionHandler(.cancel)
        model?.webFailed(s.id)
        return
      }
      let attachment =
        http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment")
        == true
      let path = http.url?.path ?? ""
      decisionHandler(
        attachment || Wire.route(path.isEmpty ? "/" : path) == nil || !response.canShowMIMEType
          || http.mimeType != "text/html" ? .download : .allow)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
      guard trusted(webView) else {
        webView.stopLoading()
        model?.webFailed(s.id)
        return
      }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { model?.webFailed(s.id) }
    func webView(
      _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: Error
    ) { navigationFailed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      navigationFailed(error)
    }
    private func navigationFailed(_ error: Error) {
      let e = error as NSError
      if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled)
        || (e.domain == WKError.errorDomain && e.code == 102)
      {
        return
      }
      model?.webFailed(s.id)
    }
    private func call(_ body: String, args: [String: Any] = [:], done: ((Bool) -> Void)? = nil) {
      guard let view, trusted(view) else {
        done?(false)
        return
      }
      view.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { result in
        if case let .success(value) = result { done?(value as? Bool == true) } else { done?(false) }
      }
    }
    func sidebar() { call("return window.__T3_MOBILE_BRIDGE__?.toggleSidebar()") }
    func reconnect() { call("return await window.__T3_MOBILE_BRIDGE__?.reconnect()") }
    func insertDraft(_ text: String, done: @escaping (Bool) -> Void) {
      call(
        "return window.__T3_MOBILE_BRIDGE__?.insertDraft(text)", args: ["text": text], done: done)
    }
    @objc private func keyboard(_ note: Notification) {
      guard let view, let screen = view.window?.screen, let info = note.userInfo,
        let rect = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
      else { return }
      let local = view.convert(rect, from: screen.coordinateSpace)
      let intersection = view.bounds.intersection(local)
      let overlap =
        note.name == UIResponder.keyboardWillHideNotification || intersection.isNull
          || local.maxY < view.bounds.maxY ? 0 : intersection.height
      call(
        "window.__T3_MOBILE_BRIDGE__?.setKeyboard(px, ms)",
        args: [
          "px": overlap,
          "ms": (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25) * 1000,
        ])
    }
    func captureFrame() {
      guard let view, trusted(view), model?.ready == true else { return }
      let cfg = WKSnapshotConfiguration()
      cfg.afterScreenUpdates = false
      view.takeSnapshot(with: cfg) { [weak self] image, _ in
        if let self, let image { model?.saveFrame(image, session: s) }
      }
    }
    func webView(
      _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
    ) { download.delegate = self }
    func webView(
      _ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
    ) { download.delegate = self }
    func download(
      _ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      guard current else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      policy.answer(challenge, completionHandler)
    }
    func download(
      _ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void
    ) { decisionHandler(.cancel) }
    func download(
      _ download: WKDownload, decideDestinationUsing response: URLResponse,
      suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
    ) {
      guard current, s.endpoint.matches(response.url) else {
        completionHandler(nil)
        return
      }
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString, isDirectory: true)
      let name = (suggestedFilename as NSString).lastPathComponent
      guard !name.isEmpty, !name.hasPrefix("."), !name.contains("/"), !name.contains("\\") else {
        completionHandler(nil)
        return
      }
      do {
        try FileManager.default.createDirectory(
          at: dir, withIntermediateDirectories: false,
          attributes: [.protectionKey: FileProtectionType.complete])
        let url = dir.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
      } catch { completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
      guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
      guard current, previewURL == nil, QLPreviewController.canPreview(url as NSURL),
        let root = view?.window?.rootViewController, root.presentedViewController == nil
      else {
        cleanup(url)
        return
      }
      previewURL = url
      let q = QLPreviewController()
      q.dataSource = self
      q.delegate = self
      root.present(q, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
      if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { cleanup(url) }
    }
    private func cleanup(_ url: URL) {
      try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
      previewURL == nil ? 0 : 1
    }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> QLPreviewItem
    { (previewURL ?? FileManager.default.temporaryDirectory) as NSURL }
    nonisolated func previewControllerDidDismiss(_ controller: QLPreviewController) {
      Task { @MainActor in
        if let url = self.previewURL { self.cleanup(url) }
        self.previewURL = nil
      }
    }
  }
}
@MainActor private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: OfficialWebView.Coordinator?
  init(_ target: OfficialWebView.Coordinator) { self.target = target }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(c, didReceive: message)
  }
}
