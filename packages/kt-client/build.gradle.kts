plugins {
    kotlin("jvm") version "2.0.20"
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
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = false
    }
}
