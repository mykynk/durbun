import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.durbun"
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
            // The SDK core is plain JVM code; Android stubs return defaults instead of throwing.
            isReturnDefaultValues = true
            all { test ->
                test.maxHeapSize = "512m"
                test.maxParallelForks = 1
            }
        }
    }
}

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
}

dependencies {
    // OkHttp is the app's own dependency: the interceptor links against whatever version the app ships
    // (3.14 … 5.x). Kotlin stdlib comes from the Kotlin plugin.
    compileOnly("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlin")
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:okhttp:4.12.0") {
        exclude(group = "org.jetbrains.kotlin")
    }
}
