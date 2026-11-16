// Dürbün Android SDK — standalone build (for tests and AAR builds).
// Apps normally include the modules from a local path instead; see README.md.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "durbun-android"

include(":durbun")
include(":durbun-noop")

// The sample app (sample/, see its README) joins the build only when it is asked for: a task of it
// (`./gradlew :sample:assembleDebug`), `-Pdurbun.sample`, or an Android Studio sync. The library builds and
// what they publish stay exactly as they are without it.
val sampleRequested = gradle.startParameter.taskNames.any { it.startsWith(":sample:") || it.startsWith("sample:") } ||
    providers.gradleProperty("durbun.sample").isPresent ||
    providers.gradleProperty("android.injected.invoked.from.ide").isPresent ||
    providers.systemProperty("idea.sync.active").orNull == "true"
if (sampleRequested) include(":sample")
