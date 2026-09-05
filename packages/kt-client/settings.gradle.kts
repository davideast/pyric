pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "kt-client"
include(":debug-compose")
project(":debug-compose").projectDir = file("debug-compose")
