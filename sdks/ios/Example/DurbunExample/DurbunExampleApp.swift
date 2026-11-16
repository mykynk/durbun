import Durbun
import SwiftUI

@main
struct DurbunExampleApp: App {
    @StateObject private var demo: Demo

    init() {
        // Start Dürbün as early as possible: sessions created after this line are captured. In the Simulator and
        // on an iPhone over USB nothing else is needed; for Wi-Fi, pass DurbunOptions(host: "<the Mac's IP>").
        // An app that ships to users would put this (and `import Durbun`) inside `#if DEBUG`; this example
        // always calls it, and the SDK still runs only in development builds by itself.
        Durbun.start(options: DurbunOptions(
            redactHeaders: ["Authorization"], // shown as •••• in the Mac app; the request is unchanged
            appName: "Dürbün example"
        ))
        _demo = StateObject(wrappedValue: Demo())
    }

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(demo)
        }
    }
}
