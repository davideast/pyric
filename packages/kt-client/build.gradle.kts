plugins {
    kotlin("jvm") version "2.1.20"
}

repositories {
    google()
    mavenCentral()
}

dependencies {
    // WebSocket Transport & Protocol
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Kotlin Coroutines & Flow
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")

    // Test Harness (JUnit 5 & Coroutine Testing)
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
        // Compile against the Java 11 API too, so a newer JDK call fails here
        // rather than on an Android module's Java 11 or 17 test JVM.
        freeCompilerArgs.add("-Xjdk-release=11")
    }
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = false
    }
}
