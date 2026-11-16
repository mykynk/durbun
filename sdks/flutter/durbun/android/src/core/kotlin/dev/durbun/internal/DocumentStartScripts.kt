package dev.durbun.internal

/**
 * Document-start scripts through androidx.webkit (`WebViewCompat.addDocumentStartJavaScript`), when the app has it
 * and the device's WebView supports it. The SDK has no AndroidX dependency, so it looks the classes up at run time;
 * without them the caller falls back to injecting the script when a page starts loading.
 */
internal object DocumentStartScripts {
    private const val FEATURE = "DOCUMENT_START_SCRIPT"

    /** Class names, replaceable by tests. */
    @Volatile
    var featureClass = "androidx.webkit.WebViewFeature"

    @Volatile
    var compatClass = "androidx.webkit.WebViewCompat"

    /** Adds [script] to every frame of [webView] at document start; false when that is not available here. */
    fun add(webView: Any, script: String): Boolean = try {
        val feature = Class.forName(featureClass)
        val supported = feature.getMethod("isFeatureSupported", String::class.java).invoke(null, FEATURE) == true
        if (!supported) {
            false
        } else {
            val add = Class.forName(compatClass).methods.firstOrNull {
                it.name == "addDocumentStartJavaScript" && it.parameterTypes.size == 3 &&
                    it.parameterTypes[0].isInstance(webView) && it.parameterTypes[1] == String::class.java
            }
            if (add == null) {
                false
            } else {
                add.invoke(null, webView, script, setOf("*"))
                true
            }
        }
    } catch (_: Throwable) {
        false
    }
}
