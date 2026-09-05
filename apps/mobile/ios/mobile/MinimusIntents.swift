import AppIntents
import UIKit

/**
 * App Intents: the low-resistance ways in.
 *
 *  - "Hey Siri, ask Minimus" → AskMinimusIntent. Siri asks "What should
 *    Minimus do?", takes the answer as text, and the app opens straight into
 *    the run. (App Shortcut phrases cannot carry free text, so the request
 *    is collected as a follow-up question.)
 *  - "Hey Siri, talk to Minimus" → TalkToMinimusIntent (opens with the mic
 *    live and speaks the answer — the "call on speaker" feel).
 *  - Both appear in the Shortcuts app, so they can be put on the Action
 *    button, Back Tap, a lock-screen widget or a Focus automation.
 *
 * The app already handles minimus://ask?q= and minimus://ask?listen=1, so the
 * intents just open those URLs; nothing here talks to the model directly.
 */

@available(iOS 16.0, *)
struct AskMinimusIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Minimus"
  static var description = IntentDescription("Send a request to Minimus, the on-device assistant.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Request", requestValueDialog: "What should Minimus do?")
  var request: String

  static var parameterSummary: some ParameterSummary {
    Summary("Ask Minimus to \(\.$request)")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    var comps = URLComponents()
    comps.scheme = "minimus"
    comps.host = "ask"
    comps.queryItems = [URLQueryItem(name: "q", value: request)]
    if let url = comps.url { await UIApplication.shared.open(url) }
    return .result()
  }
}

@available(iOS 16.0, *)
struct TalkToMinimusIntent: AppIntent {
  static var title: LocalizedStringResource = "Talk to Minimus"
  static var description = IntentDescription("Open Minimus listening, and hear the answer spoken.")
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    if let url = URL(string: "minimus://ask?listen=1") { await UIApplication.shared.open(url) }
    return .result()
  }
}

@available(iOS 16.0, *)
struct MinimusShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskMinimusIntent(),
      phrases: [
        "Ask \(.applicationName)",
        "Tell \(.applicationName) something",
        "New \(.applicationName) request",
      ],
      shortTitle: "Ask Minimus",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: TalkToMinimusIntent(),
      phrases: [
        "Talk to \(.applicationName)",
        "Open \(.applicationName) and listen",
      ],
      shortTitle: "Talk to Minimus",
      systemImageName: "waveform"
    )
  }
}
