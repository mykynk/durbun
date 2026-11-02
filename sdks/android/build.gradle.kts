// Plugin versions for the standalone build only. When an app includes `:durbun` / `:durbun-noop`
// from a local path, the app's own Android Gradle Plugin and Kotlin plugin are used instead
// (the modules apply the plugins without versions).
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20")
    }
}
