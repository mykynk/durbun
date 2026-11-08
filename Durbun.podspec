#
# Dürbün iOS SDK for CocoaPods (native iOS apps). Swift Package Manager uses ./Package.swift; both build
# sdks/ios/Sources/Durbun. Flutter apps use package:durbun instead, which carries its own copy.
#
#   pod 'Durbun'
#
# The version must match `Durbun.version` (sdks/ios/Sources/Durbun/Public/Durbun.swift) and the git tag.
#
Pod::Spec.new do |s|
  s.name             = 'Durbun'
  s.version          = '0.1.0'
  s.summary          = 'Streams an iOS app\'s logs, URLSession traffic, crashes and metrics to the Dürbün desktop app.'
  s.description      = <<-DESC
Dürbün iOS SDK: sends print/stdout/stderr and os_log lines, URLSession traffic (headers, bodies, timings),
crashes, custom events and performance metrics to the Dürbün desktop inspector on your Mac, applies its
mock rules and runs its in-app actions.
                       DESC
  s.homepage         = 'https://github.com/mykynk/durbun'
  s.license          = { :type => 'MIT', :file => 'LICENSE' }
  s.author           = { 'Muhammed Yusuf Kaynak' => 'https://github.com/mykynk' }
  s.source           = { :git => 'https://github.com/mykynk/durbun.git', :tag => "v#{s.version}" }

  s.ios.deployment_target = '13.0'
  s.osx.deployment_target = '11.0'
  s.swift_versions   = ['5.9']

  s.source_files     = 'sdks/ios/Sources/Durbun/**/*.swift'
  s.resource_bundles = { 'Durbun_Privacy' => ['sdks/ios/Sources/Durbun/PrivacyInfo.xcprivacy'] }
  s.frameworks       = 'Foundation', 'Network'
end
