#
# iOS side of package:durbun (CocoaPods). Swift Package Manager uses durbun/Package.swift; both build the
# same sources in durbun/Sources/durbun:
#   DurbunFlutterPlugin.swift  the Flutter glue (method channel)
#   Core/                      the native iOS core, an exact copy of sdks/ios/Sources/Durbun
#                              (CocoaPods and SwiftPM cannot compile files outside the plugin folder).
#                              Refresh it with `dart run tool/sync_native.dart`; a unit test fails when the
#                              copy drifts from the original.
#
Pod::Spec.new do |s|
  s.name             = 'durbun'
  s.version          = '0.2.0'
  s.summary          = 'Dürbün SDK for Flutter: native iOS layer (crashes, URLSession, native logs).'
  s.description      = <<-DESC
Streams the app's native iOS crashes, URLSession traffic, stdout/stderr and Swift logs to the Dürbün
desktop inspector through the Dart SDK's connection. Inert until the Dart side starts it.
                       DESC
  s.homepage         = 'https://github.com/mykynk/durbun'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = { 'Muhammed Yusuf Kaynak' => 'https://github.com/mykynk' }
  s.source           = { :path => '.' }
  s.source_files     = 'durbun/Sources/durbun/**/*.swift'
  s.resource_bundles = { 'durbun_privacy' => ['durbun/Sources/durbun/PrivacyInfo.xcprivacy'] }
  s.dependency 'Flutter'
  s.platform = :ios, '13.0'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'
end
