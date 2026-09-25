package com.cryptopulse.app.forensics

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * Monitors application lifecycle, detects unclean shutdowns/restarts, and
 * maintains an active heartbeat for ShrikantTelang_ForensicCID.
 */
class ForensicLifecycleObserver(
    private val application: Application,
    private val onLifecycleEvent: (eventType: String, details: Map<String, Any?>) -> Unit
) : Application.ActivityLifecycleCallbacks {

    companion object {
        private const val TAG = "ForensicLifecycle"
        private const val PREFS_NAME = "cid_forensic_heartbeat"
        private const val KEY_LAST_HEARTBEAT = "last_heartbeat"
        private const val KEY_CLEAN_SHUTDOWN = "clean_shutdown"
        private const val HEARTBEAT_INTERVAL_MS = 15000L
    }

    private val prefs: SharedPreferences by lazy {
        application.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val activeActivityCount = AtomicInteger(0)
    private var heartbeatJob: Job? = null

    fun register() {
        application.registerActivityLifecycleCallbacks(this)
        checkStartupState()
        startHeartbeat()
    }

    private fun checkStartupState() {
        val lastHeartbeat = prefs.getLong(KEY_LAST_HEARTBEAT, 0L)
        val cleanShutdown = prefs.getBoolean(KEY_CLEAN_SHUTDOWN, true)
        val now = System.currentTimeMillis()

        if (!cleanShutdown && lastHeartbeat > 0L && (now - lastHeartbeat) > 20000L) {
            val gapMs = now - lastHeartbeat
            Log.w(TAG, "[ShrikantTelang_ForensicCID] Detected restart after unclean shutdown! Gap: ${gapMs}ms")
            onLifecycleEvent(
                "APP_RESTART_UNCLEAN",
                mapOf(
                    "last_heartbeat_timestamp" to lastHeartbeat,
                    "gap_duration_ms" to gapMs,
                    "reason" to "Previous session terminated without clean stop event"
                )
            )
        }

        // Record fresh APP_START
        prefs.edit()
            .putBoolean(KEY_CLEAN_SHUTDOWN, false)
            .putLong(KEY_LAST_HEARTBEAT, now)
            .apply()

        val startDetails = mapOf(
            "pid" to Process.myPid(),
            "os_version" to "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "device_model" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "package_name" to application.packageName,
            "runtime_timestamp" to now
        )
        onLifecycleEvent("APP_START", startDetails)
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                prefs.edit().putLong(KEY_LAST_HEARTBEAT, System.currentTimeMillis()).apply()
            }
        }
    }

    fun markCleanShutdown() {
        prefs.edit().putBoolean(KEY_CLEAN_SHUTDOWN, true).apply()
        onLifecycleEvent("APP_STOP", mapOf("clean_shutdown" to true))
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

    override fun onActivityStarted(activity: Activity) {
        if (activeActivityCount.incrementAndGet() == 1) {
            onLifecycleEvent("APP_FOREGROUND", mapOf("top_activity" to activity.javaClass.simpleName))
        }
    }

    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}

    override fun onActivityStopped(activity: Activity) {
        if (activeActivityCount.decrementAndGet() == 0) {
            onLifecycleEvent("APP_BACKGROUND", mapOf("last_activity" to activity.javaClass.simpleName))
        }
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}
