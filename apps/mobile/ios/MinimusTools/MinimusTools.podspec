Pod::Spec.new do |s|
  s.name         = "MinimusTools"
  s.version      = "0.2.0"
  s.summary      = "Native phone-control tools for Minimus"
  s.homepage     = "https://runanywhere.ai"
  s.license      = { :type => "MIT" }
  s.authors      = "RunAnywhere AI"
  s.platforms    = { :ios => "17.5" }
  s.source       = { :path => "." }
  s.source_files = "*.{h,m,c,swift}"
  s.swift_version = "5.0"
  s.frameworks   = "AVFoundation", "EventKit", "UserNotifications", "UIKit", "Contacts", "Speech"
  # AlarmKit exists from iOS 26; weak-linked so the app still launches on 17.5+
  # and the Swift code checks availability at run time.
  s.weak_frameworks = "AlarmKit", "AppIntents", "ActivityKit"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }
  s.dependency "React-Core"
end
