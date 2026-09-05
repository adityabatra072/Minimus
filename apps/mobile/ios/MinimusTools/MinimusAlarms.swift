import Foundation
import SwiftUI
import React
#if canImport(AlarmKit)
import AlarmKit
#endif
import AVFoundation
import EventKit

/**
 * Real alarms and timers on iOS 26+ through AlarmKit: they ring like the Clock
 * app's, appear on the Lock Screen and in the Dynamic Island, and survive the
 * app being closed. Before AlarmKit the only path was a local notification,
 * which is silent when the phone is on Do Not Disturb and easy to miss; the
 * JS layer falls back to that on older iOS or when the user declines.
 *
 * Also here, because they are small and Swift-shaped: the system speech
 * synthesizer (a natural offline voice with no download), an audio file
 * player for cloud TTS, and a Reminders read for the daily brief.
 */

#if canImport(AlarmKit)
@available(iOS 26.0, *)
nonisolated struct MinimusAlarmMetadata: AlarmMetadata {}
#endif

@objc(MinimusAlarms)
class MinimusAlarms: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var speechResolve: RCTPromiseResolveBlock?
  private var player: AVAudioPlayer?
  private var playResolve: RCTPromiseResolveBlock?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  // MARK: - AlarmKit

  @objc func alarmAuthorization(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      Task {
        switch AlarmManager.shared.authorizationState {
        case .authorized:
          resolve("authorized")
        case .denied:
          resolve("denied")
        case .notDetermined:
          do {
            let state = try await AlarmManager.shared.requestAuthorization()
            resolve(state == .authorized ? "authorized" : "denied")
          } catch {
            resolve("denied")
          }
        @unknown default:
          resolve("denied")
        }
      }
      return
    }
    #endif
    resolve("unavailable")
  }

  /// A one-shot or daily alarm at hour:minute. Returns the alarm id.
  @objc func alarmSchedule(_ hour: NSNumber, minute: NSNumber, label: String, repeatsDaily: Bool,
                           resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      Task {
        do {
          let title = label.isEmpty ? "Alarm" : label
          let alert = AlarmPresentation.Alert(
            title: LocalizedStringResource(stringLiteral: title),
            stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.fill"),
            secondaryButton: AlarmButton(text: "Snooze", textColor: .white, systemImageName: "zzz"),
            secondaryButtonBehavior: .countdown
          )
          let attributes = AlarmAttributes<MinimusAlarmMetadata>(
            presentation: AlarmPresentation(alert: alert),
            tintColor: Color(red: 0.96, green: 0.32, blue: 0.06)
          )
          let time = Alarm.Schedule.Relative.Time(hour: hour.intValue, minute: minute.intValue)
          let recurrence: Alarm.Schedule.Relative.Recurrence = repeatsDaily
            ? .weekly([.sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday])
            : .never
          let schedule = Alarm.Schedule.relative(.init(time: time, repeats: recurrence))
          let id = UUID()
          _ = try await AlarmManager.shared.schedule(
            id: id,
            configuration: .alarm(schedule: schedule, attributes: attributes)
          )
          resolve(id.uuidString)
        } catch {
          reject("alarm_failed", "Could not schedule the alarm: \(error.localizedDescription)", error)
        }
      }
      return
    }
    #endif
    reject("unavailable", "AlarmKit needs iOS 26.", nil)
  }

  /// A countdown timer that rings after `seconds`. Returns the alarm id.
  @objc func timerStart(_ seconds: NSNumber, label: String,
                        resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      Task {
        do {
          let title = label.isEmpty ? "Timer" : label
          let alert = AlarmPresentation.Alert(
            title: LocalizedStringResource(stringLiteral: "\(title) is done"),
            stopButton: AlarmButton(text: "Done", textColor: .white, systemImageName: "checkmark")
          )
          let countdown = AlarmPresentation.Countdown(
            title: LocalizedStringResource(stringLiteral: title),
            pauseButton: AlarmButton(text: "Pause", textColor: .white, systemImageName: "pause.fill")
          )
          let paused = AlarmPresentation.Paused(
            title: LocalizedStringResource(stringLiteral: "\(title) paused"),
            resumeButton: AlarmButton(text: "Resume", textColor: .white, systemImageName: "play.fill")
          )
          let attributes = AlarmAttributes<MinimusAlarmMetadata>(
            presentation: AlarmPresentation(alert: alert, countdown: countdown, paused: paused),
            tintColor: Color(red: 0.96, green: 0.32, blue: 0.06)
          )
          let id = UUID()
          _ = try await AlarmManager.shared.schedule(
            id: id,
            configuration: .timer(duration: seconds.doubleValue, attributes: attributes)
          )
          resolve(id.uuidString)
        } catch {
          reject("timer_failed", "Could not start the timer: \(error.localizedDescription)", error)
        }
      }
      return
    }
    #endif
    reject("unavailable", "AlarmKit needs iOS 26.", nil)
  }

  /// Every alarm AlarmKit knows about for this app: id, state, kind, fire time.
  @objc func alarmList(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      var out: [[String: Any]] = []
      for alarm in (try? AlarmManager.shared.alarms) ?? [] {
        var entry: [String: Any] = ["id": alarm.id.uuidString]
        switch alarm.state {
        case .scheduled: entry["state"] = "scheduled"
        case .countdown: entry["state"] = "countdown"
        case .paused: entry["state"] = "paused"
        case .alerting: entry["state"] = "alerting"
        @unknown default: entry["state"] = "unknown"
        }
        if let schedule = alarm.schedule {
          entry["kind"] = "alarm"
          switch schedule {
          case .fixed(let date):
            entry["fireAtMs"] = date.timeIntervalSince1970 * 1000
          case .relative(let rel):
            entry["hour"] = rel.time.hour
            entry["minute"] = rel.time.minute
            var comps = DateComponents()
            comps.hour = rel.time.hour
            comps.minute = rel.time.minute
            if let next = Calendar.current.nextDate(after: Date(), matching: comps, matchingPolicy: .nextTime) {
              entry["fireAtMs"] = next.timeIntervalSince1970 * 1000
            }
          @unknown default: break
          }
        } else {
          entry["kind"] = "timer"
          if let d = alarm.countdownDuration?.preAlert { entry["durationSeconds"] = d }
        }
        out.append(entry)
      }
      resolve(out)
      return
    }
    #endif
    resolve([])
  }

  @objc func alarmCancel(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *), let uuid = UUID(uuidString: id) {
      try? AlarmManager.shared.cancel(id: uuid)
    }
    #endif
    resolve(nil)
  }

  @objc func alarmStop(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *), let uuid = UUID(uuidString: id) {
      try? AlarmManager.shared.stop(id: uuid)
    }
    #endif
    resolve(nil)
  }

  @objc func alarmPause(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *), let uuid = UUID(uuidString: id) {
      try? AlarmManager.shared.pause(id: uuid)
    }
    #endif
    resolve(nil)
  }

  @objc func alarmResume(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *), let uuid = UUID(uuidString: id) {
      try? AlarmManager.shared.resume(id: uuid)
    }
    #endif
    resolve(nil)
  }

  // MARK: - System speech (AVSpeechSynthesizer)

  /// Speak with the system voice. Resolves when speech finishes or is stopped.
  @objc func speakSystem(_ text: String, rate: NSNumber, voiceId: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      if self.synthesizer.isSpeaking { self.synthesizer.stopSpeaking(at: .immediate) }
      self.speechResolve?(nil)
      self.speechResolve = resolve
      let utterance = AVSpeechUtterance(string: text)
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate * Float(truncating: rate)
      if !voiceId.isEmpty, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
        utterance.voice = voice
      } else {
        // Prefer the best quality English voice installed (Siri-class
        // "premium"/"enhanced" voices when the user has them).
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        let ranked = voices.sorted { a, b in a.quality.rawValue > b.quality.rawValue }
        utterance.voice = ranked.first ?? AVSpeechSynthesisVoice(language: "en-US")
      }
      try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try? AVAudioSession.sharedInstance().setActive(true)
      self.synthesizer.speak(utterance)
    }
  }

  @objc func stopSystemSpeech(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.synthesizer.stopSpeaking(at: .immediate)
      resolve(nil)
    }
  }

  @objc func systemVoices(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let voices = AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.hasPrefix("en") }
      .map { v -> [String: Any] in
        ["id": v.identifier, "name": v.name, "language": v.language,
         "quality": v.quality == .premium ? "premium" : v.quality == .enhanced ? "enhanced" : "default"]
      }
    resolve(voices)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    speechResolve?(nil)
    speechResolve = nil
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    speechResolve?(nil)
    speechResolve = nil
  }

  // MARK: - Audio file playback (cloud TTS)

  @objc func playAudioFile(_ path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      do {
        self.player?.stop()
        self.playResolve?(nil)
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try AVAudioSession.sharedInstance().setActive(true)
        let url = URL(fileURLWithPath: path.replacingOccurrences(of: "file://", with: ""))
        let player = try AVAudioPlayer(contentsOf: url)
        player.delegate = self
        self.player = player
        self.playResolve = resolve
        player.play()
      } catch {
        reject("play_failed", "Could not play the audio file.", error)
      }
    }
  }

  @objc func stopAudio(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.player?.stop()
      self.playResolve?(nil)
      self.playResolve = nil
      resolve(nil)
    }
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    playResolve?(nil)
    playResolve = nil
  }

  // MARK: - Reminders (read)

  /// Incomplete reminders due within `withinHours` (or undated), for the brief.
  @objc func remindersList(_ withinHours: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let store = EKEventStore()
    store.requestFullAccessToReminders { granted, error in
      if !granted {
        reject("no_permission", "Reminders access not granted — ask the user to allow reminders for this app.", error)
        return
      }
      let end = Date().addingTimeInterval(withinHours.doubleValue * 3600)
      let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: end, calendars: nil)
      store.fetchReminders(matching: predicate) { reminders in
        let out: [[String: Any]] = (reminders ?? []).prefix(20).map { r in
          var entry: [String: Any] = ["title": r.title ?? "(untitled)"]
          if let due = r.dueDateComponents, let date = Calendar.current.date(from: due) {
            entry["dueAtMs"] = date.timeIntervalSince1970 * 1000
          }
          return entry
        }
        resolve(out)
      }
    }
  }
}
