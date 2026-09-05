import Foundation
import React
import Speech
import AVFoundation

/**
 * On-device speech recognition through Apple's SFSpeechRecognizer.
 *
 * Why not a bundled model: the phone already ships a recognizer that is
 * better than any small Whisper we could download, it runs offline
 * (`requiresOnDeviceRecognition`), it streams partial results so the composer
 * can show words as they are said, and it takes `contextualStrings`, which is
 * exactly the "boost the app's vocabulary" trick: taught phrase names, "new
 * rule", "wind down", "flashlight" get a higher prior without any prompt
 * engineering. A second LLM pass (services/voice.ts) then fixes what is left.
 *
 * Events: `MinimusSpeech` with { text, isFinal }.
 */
@objc(MinimusSpeech)
class MinimusSpeech: RCTEventEmitter {
  private let audioEngine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var finalResolve: RCTPromiseResolveBlock?
  private var lastText = ""
  private var hasListeners = false
  private var file: AVAudioFile?

  override init() {
    super.init()
  }

  @objc override static func requiresMainQueueSetup() -> Bool { return false }

  override func supportedEvents() -> [String]! { return ["MinimusSpeech", "MinimusSpeechLevel"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  @objc func speechAuthorization(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    SFSpeechRecognizer.requestAuthorization { status in
      AVAudioSession.sharedInstance().requestRecordPermission { mic in
        let speech: String
        switch status {
        case .authorized: speech = "authorized"
        case .denied: speech = "denied"
        case .restricted: speech = "restricted"
        case .notDetermined: speech = "notDetermined"
        @unknown default: speech = "denied"
        }
        let r = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        resolve([
          "speech": speech,
          "microphone": mic,
          "onDevice": r?.supportsOnDeviceRecognition ?? false,
          "available": r?.isAvailable ?? false,
        ])
      }
    }
  }

  /// Start listening. `contextualStrings` bias recognition toward app words.
  /// `recordPath` (optional) also writes the audio as WAV for cloud STT.
  @objc func speechStart(_ contextualStrings: [String], onDevice: Bool, recordPath: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.stopInternal(cancelTask: true)
      guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
        reject("unavailable", "Speech recognition is not available on this device right now.", nil)
        return
      }
      self.recognizer = recognizer
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      request.taskHint = .dictation
      if !contextualStrings.isEmpty { request.contextualStrings = Array(contextualStrings.prefix(100)) }
      if onDevice && recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
      if #available(iOS 16.0, *) { request.addsPunctuation = true }
      self.request = request
      self.lastText = ""

      let session = AVAudioSession.sharedInstance()
      do {
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
      } catch {
        reject("audio_session", "Could not open the microphone.", error)
        return
      }

      let input = self.audioEngine.inputNode
      let format = input.outputFormat(forBus: 0)
      if !recordPath.isEmpty {
        let url = URL(fileURLWithPath: recordPath.replacingOccurrences(of: "file://", with: ""))
        self.file = try? AVAudioFile(forWriting: url, settings: format.settings)
      } else {
        self.file = nil
      }
      input.removeTap(onBus: 0)
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        guard let self = self else { return }
        self.request?.append(buffer)
        try? self.file?.write(from: buffer)
        if self.hasListeners, let data = buffer.floatChannelData?[0] {
          var sum: Float = 0
          let n = Int(buffer.frameLength)
          for i in stride(from: 0, to: n, by: 8) { sum += data[i] * data[i] }
          let rms = sqrt(sum / Float(max(1, n / 8)))
          self.sendEvent(withName: "MinimusSpeechLevel", body: ["level": rms])
        }
      }
      self.audioEngine.prepare()
      do {
        try self.audioEngine.start()
      } catch {
        input.removeTap(onBus: 0)
        reject("audio_engine", "Could not start audio capture.", error)
        return
      }

      self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        guard let self = self else { return }
        if let result = result {
          self.lastText = result.bestTranscription.formattedString
          if self.hasListeners {
            self.sendEvent(withName: "MinimusSpeech", body: ["text": self.lastText, "isFinal": result.isFinal])
          }
          if result.isFinal {
            self.finalResolve?(self.lastText)
            self.finalResolve = nil
          }
        }
        if error != nil {
          // Ending audio produces a benign error alongside the final result;
          // whatever text we have is the answer.
          self.finalResolve?(self.lastText)
          self.finalResolve = nil
        }
      }
      resolve(nil)
    }
  }

  /// Stop listening and resolve with the final transcript.
  @objc func speechStop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let hadTask = self.task != nil
      self.finalResolve = resolve
      self.stopInternal(cancelTask: false)
      if !hadTask {
        resolve(self.lastText)
        self.finalResolve = nil
        return
      }
      // The recognizer normally reports a final result within a second of
      // endAudio(); if it does not, return what we have.
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
        if let r = self.finalResolve {
          r(self.lastText)
          self.finalResolve = nil
          self.task?.cancel()
          self.task = nil
        }
      }
    }
  }

  @objc func speechCancel(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.stopInternal(cancelTask: true)
      self.finalResolve = nil
      resolve(nil)
    }
  }

  private func stopInternal(cancelTask: Bool) {
    if audioEngine.isRunning {
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
    }
    file = nil
    request?.endAudio()
    request = nil
    if cancelTask {
      task?.cancel()
      task = nil
    } else {
      task?.finish()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
