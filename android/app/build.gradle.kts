import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---- Server-specific values --------------------------------------------------------------
// Resolution order: -P flag / gradle.properties, then environment, then the (gitignored)
// android/local.properties. Copy local.properties.example to local.properties and fill it in.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun prop(name: String, default: String = ""): String =
    project.findProperty(name)?.toString() ?: System.getenv(name) ?: localProps.getProperty(name) ?: default
fun required(name: String): String =
    prop(name).ifEmpty { throw GradleException("Missing $name: set it in android/local.properties (see local.properties.example)") }

val tvBase = required("MYFLIX_TV_BASE")                       // pairing + update host, e.g. https://tv.example.com
val hostSuffix = required("MYFLIX_HOST_SUFFIX")               // only hosts under this get Cloudflare headers, e.g. .example.com
val lanJellyfin = required("MYFLIX_LAN_JELLYFIN")             // LAN Jellyfin probe address, e.g. http://192.168.x.x:8096
val publicMyflix = required("MYFLIX_PUBLIC_MYFLIX_BASE")      // fallback when /pair omits it
val publicJellyfin = required("MYFLIX_PUBLIC_JELLYFIN_BASE")  // fallback when playinfo omits it
// Debug builds may point pairing/update at a mock server (e.g. http://10.0.2.2:8765); release ignores it.
val debugTvBase = prop("MYFLIX_DEBUG_TV_BASE", tvBase)

// Signing material: Gradle properties or environment only (build_apk.sh reads the Keychain).
val ksPath = prop("MYFLIX_KEYSTORE_PATH")
val ksPass = prop("MYFLIX_KEYSTORE_PASSWORD")

fun q(v: String) = "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "dev.theprivatehome.myflix"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.theprivatehome.myflix"
        minSdk = 25
        targetSdk = 34
        versionCode = 14
        versionName = "2.6.2"
        buildConfigField("String", "TV_BASE", q(tvBase))
        buildConfigField("String", "HOST_SUFFIX", q(hostSuffix))
        buildConfigField("String", "LAN_JELLYFIN", q(lanJellyfin))
        buildConfigField("String", "PUBLIC_MYFLIX_BASE", q(publicMyflix))
        buildConfigField("String", "PUBLIC_JELLYFIN_BASE", q(publicJellyfin))
        buildConfigField("String", "DEBUG_ALLOW_HOST", q(""))
    }

    signingConfigs {
        create("release") {
            if (ksPath.isNotEmpty() && ksPass.isNotEmpty()) {
                storeFile = file(ksPath)
                storePassword = ksPass
                keyAlias = "myflix"
                keyPassword = ksPass
            }
        }
    }

    buildTypes {
        debug {
            // Installs side-by-side with the real app as a separate "MyFlix Test".
            applicationIdSuffix = ".test"
            buildConfigField("String", "TV_BASE", q(debugTvBase))
            // Host that may receive the Cloudflare headers over plain http (the mock server). Debug only.
            val mockHost = if (debugTvBase == tvBase) "" else (URI(debugTvBase).host ?: "")
            buildConfigField("String", "DEBUG_ALLOW_HOST", q(mockHost))
        }
        release {
            isMinifyEnabled = false
            if (ksPath.isNotEmpty() && ksPass.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
}
