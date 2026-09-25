package com.cryptopulse.app.forensics

import android.util.Log
import com.google.gson.Gson
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Crash handler that captures fatal uncaught exceptions and immediately flushes
 * the forensic evidence to disk before the Android process terminates.
 */
class ForensicCrashHandler(
    private val diskWriter: ForensicDiskWriter,
    private val onCrashRecorded: (Throwable) -> Unit
) : Thread.UncaughtExceptionHandler {

    companion object {
        private const val TAG = "ForensicCrashHandler"
    }

    private val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
    private val gson = Gson()

    fun install() {
        Thread.setDefaultUncaughtExceptionHandler(this)
        Log.i(TAG, "[ShrikantTelang_ForensicCID] Crash handler installed successfully.")
    }

    override fun uncaughtException(t: Thread, e: Throwable) {
        try {
            val sw = StringWriter()
            e.printStackTrace(PrintWriter(sw))
            val stackTrace = sw.toString()

            val now = System.currentTimeMillis()
            val isoTime = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date(now))

            val crashRecord = ForensicLifecycleRecord(
                recordType = "LIFECYCLE_EVENT",
                timestamp = now,
                isoTimestamp = isoTime,
                eventType = "CRASH",
                details = mapOf(
                    "thread_name" to t.name,
                    "thread_id" to t.id,
                    "exception_class" to e.javaClass.name,
                    "exception_message" to (e.message ?: "No message"),
                    "stack_trace" to stackTrace,
                    "fatal" to true
                )
            )

            // Emergency direct write and flush
            val json = gson.toJson(crashRecord)
            diskWriter.writeEmergencySync(json)
            onCrashRecorded(e)
            Log.e(TAG, "[ShrikantTelang_ForensicCID] FATAL CRASH RECORDED TO FORENSIC LOG: ${e.message}")
        } catch (fatalErr: Throwable) {
            Log.e(TAG, "Failed to record fatal crash: ${fatalErr.message}", fatalErr)
        } finally {
            // Forward to default Android system handler
            defaultHandler?.uncaughtException(t, e)
        }
    }
}
