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
