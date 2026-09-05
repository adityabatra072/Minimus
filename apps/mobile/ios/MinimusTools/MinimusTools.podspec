Pod::Spec.new do |s|
  s.name         = "MinimusTools"
  s.version      = "0.1.0"
  s.summary      = "Native phone-control tools for Minimus"
  s.homepage     = "https://runanywhere.ai"
  s.license      = { :type => "MIT" }
  s.authors      = "RunAnywhere AI"
  s.platforms    = { :ios => "17.5" }
  s.source       = { :path => "." }
  s.source_files = "*.{h,m,c}"
  s.frameworks   = "AVFoundation", "EventKit", "UserNotifications", "UIKit", "Contacts"
  s.dependency "React-Core"
end
