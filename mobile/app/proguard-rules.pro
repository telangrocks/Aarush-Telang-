# Gson specific rules to preserve model field names
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# Keep our API data models from being renamed
-keep class com.cryptopulse.app.data.api.** { *; }
-keep class com.cryptopulse.app.domain.model.** { *; }
