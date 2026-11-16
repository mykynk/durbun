import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

// A small app that shows the SDK's whole surface on one screen. It uses the Android platform, OkHttp and
// androidx.webkit (so the web view page shows the document-start path); nothing else. Build it with
// `./gradlew :sample:assembleDebug` (see README.md).
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.durbun.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.durbun.sample"
        minSdk = 21
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            // The release build gets :durbun-noop (see dependencies) and stays unsigned: it is there to show
            // that the same code compiles against the no-op artifact.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    lint {
        // Lint needs downloads an offline build lacks; the sample is not published.
        checkReleaseBuilds = false
    }
}

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
}

dependencies {
    debugImplementation(project(":durbun"))        // the real SDK in debug builds
    releaseImplementation(project(":durbun-noop")) // the same API with empty bodies in release builds

    implementation("com.squareup.okhttp3:okhttp:4.12.0") {
        // The Kotlin standard library comes from the Kotlin plugin.
        exclude(group = "org.jetbrains.kotlin")
    }

    // Lets DurbunWebView add its script at document start (before the page's own scripts, in every frame).
    // The sample's own dependency: the SDK modules never depend on AndroidX. 1.12.1 is the last release for minSdk 21.
    implementation("androidx.webkit:webkit:1.12.1")
}
