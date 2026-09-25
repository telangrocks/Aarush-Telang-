package com.cryptopulse.app

import android.app.Application
import com.cryptopulse.app.data.api.CidService
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.forensics.CidDiagnosticManager
import com.cryptopulse.app.forensics.ShrikantTelang_ForensicCID
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.android.HiltAndroidApp
import dagger.hilt.components.SingletonComponent

@HiltAndroidApp
class CryptoPulseApp : Application() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface AppEntryPoint {
        fun getCidService(): CidService
        fun getTokenManager(): TokenManager
    }

    override fun onCreate() {
        super.onCreate()
        ShrikantTelang_ForensicCID.initialize(this)
        try {
            val entryPoint = EntryPointAccessors.fromApplication(this, AppEntryPoint::class.java)
            val cidService = entryPoint.getCidService()
            val tokenManager = entryPoint.getTokenManager()
            CidDiagnosticManager.initialize(this, cidService, tokenManager)
        } catch (e: Exception) {
            android.util.Log.e("CryptoPulseApp", "Failed to resolve Hilt dependencies for CID: ${e.message}", e)
            CidDiagnosticManager.initialize(this)
        }
    }
}
