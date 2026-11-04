# ==============================================================================
# RETROFIT & KOTLIN COROUTINES REFLECTION CONFIGURATION
# ==============================================================================

# Retain all generic signatures, annotations, and enclosing method metadata
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keepattributes AnnotationDefault

# Retain Retrofit and OkHttp without obfuscation
-keep class retrofit2.** { *; }
-keep interface retrofit2.** { *; }
-dontwarn retrofit2.**
-dontwarn okhttp3.**
-dontwarn okio.**

# Retain Kotlin coroutines Continuation without obfuscation so Retrofit recognizes suspend functions
-keep class kotlin.coroutines.Continuation { *; }
-keep interface kotlin.coroutines.Continuation { *; }

# Retain all Retrofit API interfaces and their method signatures
-keep interface com.cryptopulse.app.data.api.** {
    <methods>;
}

# ==============================================================================
# GSON & DATA TRANSFER OBJECTS (DTOs)
# ==============================================================================

# Gson reflection and serialized name preservation
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class com.google.gson.** { *; }
-dontwarn com.google.gson.**

# Retain all CryptoPulse API models, DTOs, network results, and domain models
-keep class com.cryptopulse.app.data.api.** { *; }
-keep class com.cryptopulse.app.data.api.dto.** { *; }
-keep class com.cryptopulse.app.domain.model.** { *; }
-keep class com.cryptopulse.app.core.network.** { *; }
-keep class com.cryptopulse.app.core.error.** { *; }
