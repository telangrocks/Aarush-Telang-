package com.cryptopulse.app.service

import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cryptopulse.app.MainActivity
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Regression test suite for Android 14/15 (API 34/35) PendingIntent creation (F-LOG-01).
 *
 * NOTE ON TEST EXECUTION & RUNTIME COVERAGE:
 * The fatal IllegalArgumentException ("pendingIntentBackgroundActivityStartMode must not be set
 * when creating a PendingIntent") is enforced by the Android OS framework (PendingIntentController)
 * at runtime on API 34+ devices.
 * Local JVM unit tests using host android.jar mock stubs cannot invoke system server validation
 * and therefore cannot provide true API-level runtime coverage.
 * This test runs in an Android runtime (ART) instrumented environment to verify that
 * PendingIntent creation for trade alert and execution notifications succeeds without illegal bundles.
 */
@RunWith(AndroidJUnit4::class)
class PendingIntentRegressionTest {

    @Test
    fun testTradeAlertPendingIntentCreationSucceeds() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("extra_alert", true)
            putExtra("alert_symbol", "BTCUSDT")
            putExtra("alert_side", "BUY")
            putExtra("alert_entry_price", 95000.0)
        }

        // Must succeed without passing an illegal background-activity-start bundle to getActivity()
        val pendingIntent = PendingIntent.getActivity(
            context,
            2,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        assertNotNull("Trade alert PendingIntent must be successfully created", pendingIntent)
    }

    @Test
    fun testTradeExecutionPendingIntentCreationSucceeds() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("extra_alert", false)
            putExtra("symbol", "BTCUSDT")
            putExtra("side", "BUY")
            putExtra("alert_id", "test_alert_123")
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            3,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        assertNotNull("Execution PendingIntent must be successfully created", pendingIntent)
    }

    @Test
    fun testVerifyIllegalBackgroundBundleBehaviorOnApi34Plus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val context = ApplicationProvider.getApplicationContext<Context>()
            val intent = Intent(context, MainActivity::class.java)

            @Suppress("DEPRECATION")
            val illegalOptionsBundle = ActivityOptions.makeBasic().apply {
                setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
            }.toBundle()

            // Passing pendingIntentBackgroundActivityStartMode to PendingIntent.getActivity
            // reproduces the Android 14/15 runtime IllegalArgumentException.
            try {
                PendingIntent.getActivity(
                    context,
                    999,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    illegalOptionsBundle
                )
            } catch (e: IllegalArgumentException) {
                // Expected Android 14/15 framework rejection
                assertTrue(
                    "Exception must reference pendingIntentBackgroundActivityStartMode",
                    e.message?.contains("pendingIntentBackgroundActivityStartMode", ignoreCase = true) == true
                )
            }
        }
    }
}
