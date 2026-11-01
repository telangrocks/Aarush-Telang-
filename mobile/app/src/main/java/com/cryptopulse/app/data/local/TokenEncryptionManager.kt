package com.cryptopulse.app.data.local

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * TokenEncryptionManager
 *
 * Provides hardware-backed AES-256-GCM encryption for sensitive authentication tokens
 * stored in Android DataStore.
 *
 * Features:
 * - Uses Android KeyStore ("AndroidKeyStore") with AES/GCM/NoPadding (256-bit key) on Android.
 * - Automatic self-healing: if an encryption key is damaged, corrupted, or cannot be recovered,
 *   it safely regenerates the key without throwing or crashing.
 * - Safe fallback to in-memory AES-256 key in standard JVM unit tests where AndroidKeyStore
 *   provider is absent.
 * - Never logs or exposes plaintext tokens or key material.
 */
class TokenEncryptionManager(
    private val context: Context? = null,
    private val keyAlias: String = "cryptopulse_token_key"
) {

    companion object {
        private const val TAG = "TokenEncryptionManager"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_LENGTH_BYTES = 12
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val KEY_SIZE_BITS = 256
    }

    private val isAndroidKeyStoreAvailable: Boolean by lazy {
        try {
            val ks = KeyStore.getInstance(ANDROID_KEYSTORE)
            ks.load(null)
            true
        } catch (_: Throwable) {
            false
        }
    }

    // In-memory key for JVM unit tests where AndroidKeyStore provider is unavailable
    private val jvmTestKey: SecretKey by lazy {
        val kg = KeyGenerator.getInstance("AES")
        kg.init(KEY_SIZE_BITS, SecureRandom())
        kg.generateKey()
    }

    @Synchronized
    private fun getOrCreateKey(): SecretKey {
        if (!isAndroidKeyStoreAvailable) {
            return jvmTestKey
        }

        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(keyAlias)) {
            val key = keyStore.getKey(keyAlias, null)
            if (key is SecretKey) {
                return key
            } else {
                Log.w(TAG, "Key with alias $keyAlias is not a SecretKey. Re-generating...")
                keyStore.deleteEntry(keyAlias)
            }
        }

        return generateKeyInternal()
    }

    @Synchronized
    private fun generateKeyInternal(): SecretKey {
        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .setRandomizedEncryptionRequired(true)
            .build()

        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    @Synchronized
    fun deleteKey() {
        if (isAndroidKeyStoreAvailable) {
            try {
                val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
                if (keyStore.containsAlias(keyAlias)) {
                    keyStore.deleteEntry(keyAlias)
                    Log.i(TAG, "Deleted KeyStore alias: $keyAlias")
                }
            } catch (e: Throwable) {
                Log.w(TAG, "Failed to delete KeyStore alias: ${e.message}")
            }
        }
    }

    /**
     * Encrypts plaintext string using AES-GCM (256-bit).
     * Returns Base64-encoded string: [12-byte IV + ciphertext + 16-byte auth tag].
     */
    fun encrypt(plaintext: String): String {
        return try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv ?: throw IllegalStateException("Cipher failed to generate IV")
            val encryptedBytes = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

            val combined = ByteArray(iv.size + encryptedBytes.size)
            System.arraycopy(iv, 0, combined, 0, iv.size)
            System.arraycopy(encryptedBytes, 0, combined, iv.size, encryptedBytes.size)

            encodeBase64(combined)
        } catch (e: Throwable) {
            Log.e(TAG, "Encryption failed with ${e.javaClass.simpleName}. Attempting key recovery...")
            // Attempt one recovery by recreating key
            try {
                deleteKey()
                val freshKey = getOrCreateKey()
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, freshKey)
                val iv = cipher.iv ?: throw IllegalStateException("Cipher failed to generate IV")
                val encryptedBytes = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

                val combined = ByteArray(iv.size + encryptedBytes.size)
                System.arraycopy(iv, 0, combined, 0, iv.size)
                System.arraycopy(encryptedBytes, 0, combined, iv.size, encryptedBytes.size)

                encodeBase64(combined)
            } catch (recoveryErr: Throwable) {
                Log.e(TAG, "Key recovery encrypt failed: ${recoveryErr.javaClass.simpleName}")
                throw recoveryErr
            }
        }
    }

    /**
     * Decrypts Base64-encoded [12-byte IV + ciphertext + 16-byte auth tag] using AES-GCM.
     * Returns decrypted plaintext, or null if decryption fails (e.g., tag mismatch, corrupted key).
     * NEVER crashes the process.
     */
    fun decrypt(ciphertextBase64: String): String? {
        if (ciphertextBase64.isBlank()) return null
        return try {
            val combined = decodeBase64(ciphertextBase64)
            if (combined.size <= GCM_IV_LENGTH_BYTES) {
                Log.w(TAG, "Encrypted payload too short (${combined.size} bytes)")
                return null
            }

            val iv = combined.copyOfRange(0, GCM_IV_LENGTH_BYTES)
            val encryptedBytes = combined.copyOfRange(GCM_IV_LENGTH_BYTES, combined.size)

            val key = getOrCreateKey()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            val spec = GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv)
            cipher.init(Cipher.DECRYPT_MODE, key, spec)

            val decryptedBytes = cipher.doFinal(encryptedBytes)
            String(decryptedBytes, Charsets.UTF_8)
        } catch (e: Throwable) {
            // Corrupted keyset, bad tag, or key rotation: return null safely without crash
            Log.w(TAG, "Decryption failed safely (${e.javaClass.simpleName}). Corrupted data or rotated key.")
            null
        }
    }

    private fun encodeBase64(bytes: ByteArray): String {
        return try {
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        } catch (_: Throwable) {
            java.util.Base64.getEncoder().encodeToString(bytes)
        }
    }

    private fun decodeBase64(str: String): ByteArray {
        return try {
            android.util.Base64.decode(str, android.util.Base64.NO_WRAP)
        } catch (_: Throwable) {
            java.util.Base64.getDecoder().decode(str)
        }
    }
}
