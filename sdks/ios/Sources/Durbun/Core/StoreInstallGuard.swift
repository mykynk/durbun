import Foundation

/// Dürbün never runs in store builds. A release build made with Dürbün switched on (Flutter
/// `--dart-define=DURBUN=true`, `allowInReleaseBuilds`) can still reach the App Store by mistake, so the
/// SDK looks at the app's receipt and turns itself off in App Store installs.
enum StoreInstallGuard {
    /// Last path component of the app's receipt URL: `receipt` for App Store installs, `sandboxReceipt`
    /// for TestFlight, development and ad-hoc builds. Tests replace it.
    static var receiptName: () -> String? = { StoreInstallGuard.bundleReceiptName() }

    static let messageTR = "Dürbün kendini kapattı: uygulama mağazadan kurulmuş (Dürbün mağaza sürümlerinde çalışmaz)."
    static let messageEN = "Dürbün turned itself off: this app was installed from the store (Dürbün never runs in store builds)."

    /// True when the app was installed from the App Store (production).
    static var isStoreInstall: Bool { isStoreReceipt(receiptName()) }

    static func isStoreReceipt(_ name: String?) -> Bool { name == "receipt" }

    /// The one line Dürbün logs when it turns itself off: Turkish on Turkish devices, English otherwise.
    static func message(preferredLanguages: [String] = Locale.preferredLanguages) -> String {
        let language = preferredLanguages.first?.lowercased()
            .split(whereSeparator: { $0 == "-" || $0 == "_" }).first
        return language == "tr" ? messageTR : messageEN
    }

    private static func bundleReceiptName() -> String? {
        #if os(iOS) && !targetEnvironment(macCatalyst)
        return Bundle.main.appStoreReceiptURL?.lastPathComponent
        #else
        // macOS and Mac Catalyst report `_MASReceipt/receipt` for every build; the guard is for iOS apps.
        return nil
        #endif
    }
}
