import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.gradle.api.tasks.testing.logging.TestLogEvent
import java.io.File

plugins {
    id("com.android.library") version "8.8.2"
    id("org.jetbrains.kotlin.android") version "2.4.21"
}

val configuredBuildDir = System.getProperty("pyric.android.oracle.buildDir")
    ?: File(System.getProperty("user.home"), ".cache/pyric-android-oracle/build").absolutePath
layout.buildDirectory.set(File(configuredBuildDir))

val firebaseBomVersion: String by project

android {
    namespace = "dev.pyric.conformance.androidoracle"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { testTask ->
                testTask.javaLauncher.set(
                    javaToolchains.launcherFor {
                        languageVersion.set(JavaLanguageVersion.of(21))
                    }
                )
                testTask.testLogging {
                    events(
                        TestLogEvent.PASSED,
                        TestLogEvent.SKIPPED,
                        TestLogEvent.FAILED,
                        TestLogEvent.STANDARD_OUT,
                        TestLogEvent.STANDARD_ERROR
                    )
                    exceptionFormat = TestExceptionFormat.FULL
                    showExceptions = true
                    showCauses = true
                    showStackTraces = true
                    showStandardStreams = true
                }
                val configPath = System.getProperty("pyric.android.oracle.configPath")
                if (!configPath.isNullOrBlank()) {
                    testTask.systemProperty("pyric.android.oracle.configPath", configPath)
                }
                testTask.systemProperty("robolectric.logging.enabled", "false")
                testTask.outputs.upToDateWhen { false }
            }
        }
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:$firebaseBomVersion"))
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-database")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.18.1")
    testImplementation("androidx.test:core:1.6.1")
}
