import AVFoundation
import Speech
import SwiftUI

@MainActor final class VoiceDictation: ObservableObject {
  @Published var text = ""
  @Published var message = ""
  @Published var level: Float = 0
  @Published var listening = false
  @Published var starting = false
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?, recognition: SFSpeechRecognitionTask?
  private var installedTap = false, activeAudio = false, generation = UUID()
  func start() async {
    stop()
    let id = UUID()
    generation = id
    starting = true
    message = ""
    defer { if generation == id { starting = false } }
    let speech = await withCheckedContinuation { c in
      SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
    guard generation == id else { return }
    guard speech == .authorized else {
      message = "请在系统设置中允许语音识别。"
      return
    }
    let mic = await AVAudioApplication.requestRecordPermission()
    guard generation == id else { return }
    guard mic else {
      message = "请在系统设置中允许使用麦克风。"
      return
    }
    guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable,
      recognizer.supportsOnDeviceRecognition
    else {
      message = "当前语言或设备不支持离线听写，不会改用云端识别。"
      return
    }
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .measurement)
      try audio.setActive(true)
      activeAudio = true
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.channelCount > 0, format.sampleRate > 0 else {
        throw URLError(.resourceUnavailable)
      }
      let r = SFSpeechAudioBufferRecognitionRequest()
      r.requiresOnDeviceRecognition = true
      r.shouldReportPartialResults = true
      request = r
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        r.append(buffer)
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var power: Float = 0
        for i in 0..<Int(buffer.frameLength) { power += channel[i] * channel[i] }
        let amplitude = min(1, sqrt(power / Float(buffer.frameLength)) * 6)
        Task { @MainActor in if self?.generation == id { self?.level = amplitude } }
      }
      installedTap = true
      recognition = recognizer.recognitionTask(with: r) { [weak self] result, error in
        Task { @MainActor in
          guard let self, generation == id else { return }
          if let result { text = result.bestTranscription.formattedString }
          if error != nil || result?.isFinal == true {
            stop()
            if error != nil { message = "听写已结束，可编辑已识别文字。" }
          }
        }
      }
      engine.prepare()
      try engine.start()
      listening = true
    } catch {
      stop()
      message = "无法启动麦克风，请检查音频输入后重试。"
    }
  }
  func stop() {
    generation = UUID()
    starting = false
    listening = false
    level = 0
    if installedTap {
      engine.inputNode.removeTap(onBus: 0)
      installedTap = false
    }
    engine.stop()
    request?.endAudio()
    recognition?.cancel()
    recognition = nil
    request = nil
    if activeAudio {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      activeAudio = false
    }
  }
}
struct DictationSheet: View {
  @ObservedObject var model: AppModel
  let sessionID: UUID
  @StateObject private var voice = VoiceDictation()
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      Form {
        Section("仅在设备上识别，不自动发送") {
          ProgressView(value: Double(voice.level)).accessibilityLabel("麦克风电平")
          Button(voice.listening ? "结束听写" : "开始听写") {
            if voice.listening { voice.stop() } else { Task { await voice.start() } }
          }.disabled(voice.starting)
          TextEditor(text: $voice.text).frame(minHeight: 100)
          if !voice.message.isEmpty {
            Text(voice.message)
            Button("打开系统设置") {
              if let u = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(u)
              }
            }
          }
          Button("填入当前草稿") {
            voice.stop()
            guard model.session?.id == sessionID, let browser = model.browser else {
              voice.message = "连接已改变，未插入草稿。"
              return
            }
            browser.insertDraft(voice.text) { ok in
              if ok { dismiss() } else { voice.message = "请先在网页中打开可编辑的输入框。" }
            }
          }.disabled(voice.text.isEmpty)
        }
      }.navigationTitle("设备听写").toolbar { Button("关闭") { dismiss() } }
    }.onDisappear { voice.stop() }
  }
}
