import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

// Same public API as :durbun with empty bodies — use it for release builds
// (`releaseImplementation(project(":durbun-noop"))`) so no Dürbün code ships to users.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    // Different namespace from :durbun so both modules can live in one build; the Kotlin package is
    // still `dev.durbun`, so app code compiles unchanged against either module.
    namespace = "dev.durbun.noop"
    compileSdk = 36

    defaultConfig {
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    buildFeatures {
        buildConfig = false
    }

    publishing {
        // The javadoc jar comes from ../gradle/publish.gradle.kts (AGP's Dokka run needs downloads offline builds lack).
        singleVariant("release") {
            withSourcesJar()
        }
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

// The standalone build produces the published AAR: compile it for Kotlin 1.9 consumers (metadata, API and the
// kotlin-stdlib version in the POM), so apps on Kotlin 1.9 / 2.0 can use it. When an app includes this module from
// a local path, the app's own Kotlin compiles it and these pins are left out. (KOTLIN_1_9 is deprecated in the
// Kotlin 2.2 plugin: move to KOTLIN_2_0 when a newer build plugin drops it.)
val standalone = rootProject.name == "durbun-android"

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
    if (standalone) {
        compilerOptions.apiVersion.set(KotlinVersion.KOTLIN_1_9)
        compilerOptions.languageVersion.set(KotlinVersion.KOTLIN_1_9)
        compilerOptions.freeCompilerArgs.add("-Xsuppress-version-warnings")
    }
}

if (standalone) {
    extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension> {
        coreLibrariesVersion = "1.9.24"
    }
}

extra["durbun.artifactId"] = "durbun-noop"
extra["durbun.pomName"] = "Dürbün Android SDK (no-op)"
extra["durbun.pomDescription"] = "The Dürbün Android SDK API with empty bodies, for builds that should carry no Dürbün code."
apply(from = "../gradle/publish.gradle.kts")

dependencies {
    compileOnly("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlin")
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlin")
    }
}
