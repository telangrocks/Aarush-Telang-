package com.cryptopulse.app

import android.app.Application
import android.os.StrictMode
import com.cryptopulse.app.service.TradeAlertManager
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class CryptoPulseApp : Application() {

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
    }
}
