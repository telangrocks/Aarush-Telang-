plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    kotlin("kapt")
    alias(libs.plugins.hilt.android)
    alias(libs.plugins.google.services)
}


android {
    namespace = "com.cryptopulse.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cryptopulse.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "com.cryptopulse.app.utils.HiltTestRunner"
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    testOptions {
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
        animationsDisabled = true
        unitTests.isIncludeAndroidResources = true
    }

    signingConfigs {
        create("release") {
            val keystorePath = project.findProperty("RELEASE_STORE_FILE") as String? ?: "cryptopulse-release.keystore"
            val kFile = file(keystorePath)
            if (kFile.exists()) {
                storeFile = kFile
                storePassword = project.findProperty("RELEASE_STORE_PASSWORD") as String? ?: System.getenv("RELEASE_STORE_PASSWORD")
                keyAlias = project.findProperty("RELEASE_KEY_ALIAS") as String? ?: "cryptopulse"
                keyPassword = project.findProperty("RELEASE_KEY_PASSWORD") as String? ?: System.getenv("RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val releaseKeystore = signingConfigs.getByName("release").storeFile
            if (releaseKeystore != null && releaseKeystore.exists()) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.12"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/LICENSE*"
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
        disable += "MissingClass"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    kapt {
        correctErrorTypes = true
    }
}


dependencies {
    // Core & UI
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation(platform("androidx.compose:compose-bom:2024.02.02"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.compose.runtime:runtime-saveable")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Hilt
    implementation(libs.hilt.android)
    kapt(libs.hilt.compiler)
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")

    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // DataStore & Security
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.biometric:biometric:1.4.0-alpha03")

    // Firebase
    implementation(platform("com.google.firebase:firebase-bom:33.1.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")

    // Accompanist for WebView
    implementation("com.google.accompanist:accompanist-webview:0.32.0")

    // Unit tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")

    // Debug & Test manifest helpers
    debugImplementation(platform(libs.androidx.compose.bom))
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    // Android UI & Instrumentation Testing (Espresso, UI Automator, Compose Test, Orchestrator)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test:rules:1.5.0")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.5.1")
    androidTestImplementation("androidx.test.espresso:espresso-idling-resource:3.5.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.google.dagger:hilt-android-testing:2.51.1")
    kaptAndroidTest("com.google.dagger:hilt-compiler:2.51.1")
    androidTestUtil("androidx.test:orchestrator:1.4.2")
}


tasks.register("prepareKotlinBuildScriptModel") {
        group = "build"
        description = "Compatibility task for Android Studio Kotlin sync"
        doFirst {
            logger.info("prepareKotlinBuildScriptModel invoked for IDE sync compatibility")
        }
    }



