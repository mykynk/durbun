import org.jetbrains.kotlin.gradle.dsl.JvmTarget
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

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
}

dependencies {
    compileOnly("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlin")
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlin")
    }
}
