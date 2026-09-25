package com.cryptopulse.app.forensics

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * High-performance, asynchronous, non-blocking disk writer for ShrikantTelang_ForensicCID.
 * Appends JSON Lines to ShrikantTelang_ForensicCID.jsonl and periodically updates
 * ShrikantTelang_ForensicCID_Summary.json.
 */
class ForensicDiskWriter(private val context: Context) {

    companion object {
        private const val TAG = "ForensicDiskWriter"
        const val JSONL_FILENAME = "ShrikantTelang_ForensicCID.jsonl"
        const val SUMMARY_FILENAME = "ShrikantTelang_ForensicCID_Summary.json"
        private const val FLUSH_INTERVAL_MS = 5000L
        private const val FLUSH_EVENT_COUNT = 10
    }

    private val gson: Gson = GsonBuilder().disableHtmlEscaping().create()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val eventChannel = Channel<String>(capacity = 1000)
    private val isRunning = AtomicBoolean(false)

    private val logFile: File by lazy { resolveTargetFile(JSONL_FILENAME) }
    private val summaryFile: File by lazy { resolveTargetFile(SUMMARY_FILENAME) }

    private var bufferedWriter: BufferedWriter? = null
    private var unwrittenCount = 0
    private var lastFlushTime = System.currentTimeMillis()

    fun start() {
        if (isRunning.compareAndSet(false, true)) {
            initWriter()
            startWriterLoop()
            startPeriodicFlushLoop()
            Log.i(TAG, "[ShrikantTelang_ForensicCID] Log file initialized at: ${logFile.absolutePath}")
            Log.i(TAG, "[ShrikantTelang_ForensicCID] Summary file initialized at: ${summaryFile.absolutePath}")
        }
    }

    fun getLogFilePath(): String = logFile.absolutePath
    fun getSummaryFilePath(): String = summaryFile.absolutePath
    fun getLogFileSize(): Long = if (logFile.exists()) logFile.length() else 0L

    private fun resolveTargetFile(filename: String): File {
        return try {
            val externalDir = context.getExternalFilesDir(null)
            if (externalDir != null && (externalDir.exists() || externalDir.mkdirs())) {
                File(externalDir, filename)
            } else {
                File(context.filesDir, filename)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Fallback to internal filesDir for $filename: ${e.message}")
            File(context.filesDir, filename)
        }
    }

    private fun initWriter() {
        try {
            val file = logFile
            if (!file.exists()) {
                file.parentFile?.mkdirs()
                file.createNewFile()
            }
            bufferedWriter = BufferedWriter(FileWriter(file, true), 32768) // 32KB buffer
        } catch (e: IOException) {
            Log.e(TAG, "Failed to initialize BufferedWriter: ${e.message}", e)
        }
    }

    private fun startWriterLoop() {
        scope.launch {
            for (line in eventChannel) {
                writeLineInternal(line)
            }
        }
    }

    private fun startPeriodicFlushLoop() {
        scope.launch {
            while (isActive) {
                delay(FLUSH_INTERVAL_MS)
                flushInternal()
            }
        }
    }

    /**
     * Non-blocking queueing of any forensic record.
     */
    fun enqueueRecord(record: Any, priorityFlush: Boolean = false) {
        try {
            val jsonLine = gson.toJson(record)
            val offered = eventChannel.trySend(jsonLine).isSuccess
            if (!offered) {
                Log.w(TAG, "Channel full! Writing synchronously to avoid losing forensic record.")
                writeEmergencySync(jsonLine)
            } else if (priorityFlush) {
                scope.launch { flushInternal() }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error enqueuing forensic record: ${e.message}", e)
        }
    }

    private fun writeLineInternal(line: String) {
        try {
            if (bufferedWriter == null) {
                initWriter()
            }
            bufferedWriter?.apply {
                write(line)
                newLine()
            }
            unwrittenCount++

            val now = System.currentTimeMillis()
            if (unwrittenCount >= FLUSH_EVENT_COUNT || (now - lastFlushTime) >= FLUSH_INTERVAL_MS) {
                flushInternal()
            }
        } catch (e: IOException) {
            Log.e(TAG, "Failed to write line to log file: ${e.message}", e)
            initWriter() // Attempt re-initialization
        }
    }

    private fun flushInternal() {
        try {
            bufferedWriter?.flush()
            unwrittenCount = 0
            lastFlushTime = System.currentTimeMillis()
        } catch (e: IOException) {
            Log.e(TAG, "Failed to flush writer: ${e.message}", e)
        }
    }

    /**
     * Emergency direct synchronous write used exclusively by ForensicCrashHandler.
     * Guaranteed to persist to disk before OS terminates the crashing process.
     */
    @Synchronized
    fun writeEmergencySync(jsonLine: String) {
        try {
            flushInternal()
            FileWriter(logFile, true).use { fw ->
                fw.write(jsonLine)
                fw.write("\n")
                fw.flush()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Emergency direct write failed: ${e.message}", e)
        }
    }

    /**
     * Persists updated summary object to JSON summary file.
     */
    @Synchronized
    fun updateSummary(summary: ForensicSummary) {
        scope.launch {
            try {
                val json = gson.toJson(summary)
                FileWriter(summaryFile, false).use { fw ->
                    fw.write(json)
                    fw.flush()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to write summary: ${e.message}", e)
            }
        }
    }

    fun stop() {
        isRunning.set(false)
        try {
            flushInternal()
            bufferedWriter?.close()
            bufferedWriter = null
        } catch (e: Exception) {
            Log.e(TAG, "Error closing writer: ${e.message}", e)
        }
    }
}
