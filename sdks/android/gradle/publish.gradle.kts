// Maven publication shared by :durbun and :durbun-noop (applied from each module's build file).
//
//   ./gradlew publishToMavenLocal                      # ~/.m2/repository/io/github/mykynk/…
//   ./gradlew publishReleasePublicationToStagingRepository
//       # build/staging-deploy: zip it and upload it to the Maven Central Portal
//
// Signing is used only when a key is configured: `signingInMemoryKey` (+ `signingInMemoryKeyPassword`) as
// Gradle properties or ORG_GRADLE_PROJECT_* environment variables, or the classic `signing.keyId` set.
// The version comes from one place: `Durbun.VERSION` in durbun/src/main/kotlin/dev/durbun/Durbun.kt.

apply(plugin = "maven-publish")
apply(plugin = "signing")

val versionSource = file("../durbun/src/main/kotlin/dev/durbun/Durbun.kt")
val durbunVersion: String = Regex("""const val VERSION: String = "([^"]+)"""")
    .find(versionSource.readText())?.groupValues?.get(1)
    ?: throw GradleException("Durbun.VERSION not found in $versionSource")

group = "io.github.mykynk"
version = durbunVersion

val artifact = extra["durbun.artifactId"] as String
val pomName = extra["durbun.pomName"] as String
val pomDescription = extra["durbun.pomDescription"] as String

// Maven Central requires a javadoc jar. The API docs are the KDoc in the sources jar; this one carries the README.
val javadocJar = tasks.register<Jar>("durbunJavadocJar") {
    archiveClassifier.set("javadoc")
    from(file("../README.md"))
}

afterEvaluate {
    configure<PublishingExtension> {
        publications {
            register<MavenPublication>("release") {
                from(components["release"])
                artifact(javadocJar)
                groupId = "io.github.mykynk"
                artifactId = artifact
                version = durbunVersion
                pom {
                    name.set(pomName)
                    description.set(pomDescription)
                    url.set("https://github.com/mykynk/durbun")
                    licenses {
                        license {
                            name.set("MIT License")
                            url.set("https://opensource.org/licenses/MIT")
                            distribution.set("repo")
                        }
                    }
                    developers {
                        developer {
                            id.set("mykynk")
                            name.set("Muhammed Yusuf Kaynak")
                            url.set("https://github.com/mykynk")
                        }
                    }
                    scm {
                        url.set("https://github.com/mykynk/durbun")
                        connection.set("scm:git:https://github.com/mykynk/durbun.git")
                        developerConnection.set("scm:git:ssh://git@github.com/mykynk/durbun.git")
                    }
                    issueManagement {
                        system.set("GitHub")
                        url.set("https://github.com/mykynk/durbun/issues")
                    }
                }
            }
        }
        repositories {
            maven {
                name = "staging"
                url = uri(rootProject.layout.buildDirectory.dir("staging-deploy"))
            }
        }
    }

    val inMemoryKey = findProperty("signingInMemoryKey") as String?
    val keyRing = findProperty("signing.keyId") != null
    if (!inMemoryKey.isNullOrBlank() || keyRing) {
        configure<SigningExtension> {
            if (!inMemoryKey.isNullOrBlank()) {
                useInMemoryPgpKeys(
                    findProperty("signingInMemoryKeyId") as String?,
                    inMemoryKey,
                    findProperty("signingInMemoryKeyPassword") as String? ?: "",
                )
            }
            sign(the<PublishingExtension>().publications["release"])
        }
    }
}
