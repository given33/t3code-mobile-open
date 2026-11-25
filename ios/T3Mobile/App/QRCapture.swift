import AVFoundation
import SwiftUI

struct QRCapture: UIViewRepresentable {
  let scanned: (String) -> Void, failed: (String) -> Void
  final class Preview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
  }
  func makeCoordinator() -> Scanner { Scanner(scanned: scanned, failed: failed) }
  func makeUIView(context: Context) -> Preview {
    let v = Preview()
    v.preview.videoGravity = .resizeAspectFill
    v.preview.session = context.coordinator.session
    context.coordinator.start()
    return v
  }
  func updateUIView(_ v: Preview, context: Context) {}
  static func dismantleUIView(_ v: Preview, coordinator: Scanner) {
    coordinator.stop()
    v.preview.session = nil
  }
  final class Scanner: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession(), queue = DispatchQueue(label: "camera.capture")
    private var stopped = false, delivered = false
    let scanned: (String) -> Void, failed: (String) -> Void
    init(scanned: @escaping (String) -> Void, failed: @escaping (String) -> Void) {
      self.scanned = scanned
      self.failed = failed
    }
    func start() {
      AVCaptureDevice.requestAccess(for: .video) { allowed in
        self.queue.async {
          guard !self.stopped else { return }
          guard allowed, let cam = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: cam), self.session.canAddInput(input)
          else {
            DispatchQueue.main.async { self.failed("摄像头不可用，可在系统设置中允许相机，或粘贴配对链接。") }
            return
          }
          let output = AVCaptureMetadataOutput()
          self.session.addInput(input)
          guard self.session.canAddOutput(output) else {
            DispatchQueue.main.async { self.failed("无法启动扫码，请粘贴配对链接。") }
            return
          }
          self.session.addOutput(output)
          output.setMetadataObjectsDelegate(self, queue: self.queue)
          output.metadataObjectTypes = [.qr]
          self.session.startRunning()
        }
      }
    }
    func stop() {
      queue.async {
        self.stopped = true
        if self.session.isRunning { self.session.stopRunning() }
      }
    }
    func metadataOutput(
      _ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
      from connection: AVCaptureConnection
    ) {
      guard !stopped, !delivered,
        let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
      else { return }
      delivered = true
      DispatchQueue.main.async { self.scanned(text) }
    }
  }
}
