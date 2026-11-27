plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.p4gsavetool"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.p4gsavetool"
        minSdk = 26
        targetSdk = 34
        // CI passes GITHUB_RUN_NUMBER so every build has a higher versionCode (required to update in place).
        val run = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 0
        versionCode = 100 + run
        versionName = "1.1.$run"
    }

    // A FIXED key is what lets a new APK update the installed app without uninstalling it.
    // This key is public (it lives in the repo) and meant for personal sideloading only.
    // For distribution (e.g. Play Store) create a private keystore instead.
    signingConfigs {
        create("sideload") {
            storeFile = file("p4g-sideload.keystore")
            storePassword = "android"
            keyAlias = "p4gsavetool"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("sideload")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
}
