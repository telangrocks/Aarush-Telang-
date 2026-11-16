package com.cryptopulse.app

import android.app.Application
import android.os.StrictMode
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.service.TradeAlertManager
import com.cryptopulse.app.telemetry.AndroidStage9Observer
import dagger.hilt.android.HiltAndroidApp
import okhttp3.OkHttpClient
import javax.inject.Inject

@HiltAndroidApp
class CryptoPulseApp : Application() {

    @Inject
    lateinit var okHttpClient: OkHttpClient

    @Inject
    lateinit var tokenManager: TokenManager

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            StrictMode.setVmPolicy(
                StrictMode.VmPolicy.Builder()
                    .detectLeakedClosableObjects()
                    .penaltyLog()
                    .build()
            )
        }
        // Authoritative notification channel initialization at application cold start
        TradeAlertManager.createNotificationChannel(this)
        if (::okHttpClient.isInitialized && ::tokenManager.isInitialized) {
            AndroidStage9Observer.init(this, okHttpClient, tokenManager)
        }
    }
}
