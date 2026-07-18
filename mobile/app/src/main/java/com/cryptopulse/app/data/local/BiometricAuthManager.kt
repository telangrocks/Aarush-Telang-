package com.cryptopulse.app.data.local

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class BiometricAuthManager(private val context: Context) {

    fun isBiometricAvailable(): Int {
        val biometricManager = BiometricManager.from(context)
        return biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )
    }

    fun isBiometricEnrolled(): Boolean {
        return isBiometricAvailable() == BiometricManager.BIOMETRIC_SUCCESS
    }

    suspend fun authenticate(activity: FragmentActivity, title: String, subtitle: String): Boolean {
        return suspendCancellableCoroutine { cont ->
            val executor = ContextCompat.getMainExecutor(context)
            val biometricPrompt = BiometricPrompt(activity, executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        super.onAuthenticationError(errorCode, errString)
                        if (cont.isActive) {
                            cont.resume(false)
                        }
                    }

                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        super.onAuthenticationSucceeded(result)
                        cont.resume(true)
                    }

                    override fun onAuthenticationFailed() {
                        super.onAuthenticationFailed()
                        if (cont.isActive) {
                            cont.resume(false)
                        }
                    }
                })

            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
                )
                .build()

            cont.invokeOnCancellation {
                biometricPrompt.cancelAuthentication()
            }

            biometricPrompt.authenticate(promptInfo)
        }
    }
}
