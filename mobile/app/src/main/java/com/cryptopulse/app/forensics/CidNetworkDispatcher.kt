package com.cryptopulse.app.forensics

import android.content.Context
import android.util.Log
import com.cryptopulse.app.data.api.CidService
import com.cryptopulse.app.data.api.dto.cid.CidPostEventsRequestDto
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Non-blocking, asynchronous network dispatcher for Continuous Investigation & Diagnostics (CID).
 *
 * Batches events and dispatches them to the CryptoPulse backend via [CidService].
 * Features:
 * - Count flush (25 events) & periodic timer flush (15 seconds)
 * - Maximum batch upload of 50 events
 * - Bounded offline spillover file (cid_offline_spillover.json, max 200 events)
 * - Synchronous emergency crash write (cid_emergency_crash.json)
 * - Immediate suppression on 401/403 authorization failures (stops endless retry storms)
 * - Total error isolation: never throws, never blocks the main thread, never disrupts app functionality.
 */
class CidNetworkDispatcher(
    private val context: Context,
    private var cidService: CidService
) {

    fun setCidService(service: CidService) {
        this.cidService = service
    }

    companion object {
        private const val TAG = "CidNetworkDispatcher"
        private const val BATCH_SIZE_TRIGGER = 25
        private const val MAX_BATCH_DISPATCH = 50
        private const val FLUSH_INTERVAL_MS = 15000L
        private const val MAX_SPILLOVER_EVENTS = 200
        private const val OFFLINE_SPILLOVER_FILE = "cid_offline_spillover.json"
        private const val EMERGENCY_CRASH_FILE = "cid_emergency_crash.json"
        private const val MAX_DEAD_LETTER_EVENTS = 100
        private const val MAX_DEAD_LETTER_BYTES = 200 * 1024L // 200 KB
        private const val DEAD_LETTER_FILE = "cid_dead_letter.json"
    }

    private val gson = Gson()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val eventChannel = Channel<CidEventDto>(capacity = 100)
    private val spilloverMutex = Mutex()
    private val deadLetterMutex = Mutex()

    private val currentSessionId = AtomicReference<String?>(null)
    private val isRunning = AtomicBoolean(false)
    private val isPaused = AtomicBoolean(false)
    private val isSessionDeactivated = AtomicBoolean(false)
    private var dispatcherJob: Job? = null

    private val spilloverFile: File by lazy {
        File(context.filesDir, OFFLINE_SPILLOVER_FILE)
    }

    private val deadLetterFile: File by lazy {
        File(context.filesDir, DEAD_LETTER_FILE)
    }

    private val emergencyCrashFile: File by lazy {
        File(context.filesDir, EMERGENCY_CRASH_FILE)
    }

    fun start(sessionId: String) {
        currentSessionId.set(sessionId)
        isSessionDeactivated.set(false)
        isPaused.set(false)
        if (isRunning.compareAndSet(false, true)) {
            Log.i(TAG, "[CID] Dispatcher started for session: $sessionId")
            dispatcherJob = scope.launch {
                runDispatchLoop()
            }
            // Recover any pending emergency crash on startup
            scope.launch {
                checkAndDispatchEmergencyCrash()
            }
        }
    }

    fun updateSessionId(sessionId: String) {
        currentSessionId.set(sessionId)
        isSessionDeactivated.set(false)
        isPaused.set(false)
        Log.i(TAG, "[CID] Dispatcher session updated to: $sessionId")
    }

    fun pause() {
        isPaused.set(true)
        Log.i(TAG, "[CID] Dispatcher paused.")
    }

    fun resume() {
        isPaused.set(false)
        Log.i(TAG, "[CID] Dispatcher resumed.")
    }

    fun stop() {
        if (isRunning.compareAndSet(true, false)) {
            dispatcherJob?.cancel()
            Log.i(TAG, "[CID] Dispatcher stopped.")
        }
    }

    /**
     * Non-blocking enqueue. If channel is full, safely drops or logs without blocking.
     */
    fun enqueue(event: CidEventDto, immediateFlush: Boolean = false) {
        try {
            val result = eventChannel.trySend(event)
            if (!result.isSuccess) {
                Log.w(TAG, "[CID] Channel capacity reached, persisting event to offline spillover.")
                scope.launch {
                    saveToSpillover(listOf(event))
                }
            } else if (immediateFlush) {
                scope.launch {
                    flushPendingBatch(forceImmediate = true)
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error enqueueing event: ${t.message}")
        }
    }

    /**
     * Synchronous emergency crash write. Writes directly to disk before JVM shutdown.
     */
    fun writeEmergencyCrashSync(crashEvent: CidEventDto) {
        try {
            val json = gson.toJson(crashEvent)
            val tempFile = File(context.filesDir, "${EMERGENCY_CRASH_FILE}.tmp")
            FileOutputStream(tempFile).use { fos ->
                fos.write(json.toByteArray(Charsets.UTF_8))
                fos.flush()
                fos.fd.sync()
            }
            if (tempFile.renameTo(emergencyCrashFile)) {
                Log.i(TAG, "[CID] Synchronous emergency crash evidence saved to disk.")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Failed to write emergency crash: ${t.message}")
        }
    }

    /**
     * Recovers crash evidence written synchronously prior to previous process exit.
     */
    private suspend fun checkAndDispatchEmergencyCrash() {
        try {
            if (emergencyCrashFile.exists()) {
                val json = emergencyCrashFile.readText(Charsets.UTF_8)
                val crashEvent = gson.fromJson(json, CidEventDto::class.java)
                if (crashEvent != null) {
                    Log.i(TAG, "[CID] Recovered emergency crash from previous session. Enqueueing...")
                    enqueue(crashEvent, immediateFlush = true)
                }
                emergencyCrashFile.delete()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error reading emergency crash file: ${t.message}")
        }
    }

    private suspend fun runDispatchLoop() {
        val memoryBatch = mutableListOf<CidEventDto>()
        var lastFlushTime = System.currentTimeMillis()

        while (scope.isActive && isRunning.get()) {
            if (isPaused.get()) {
                delay(1000)
                continue
            }
            try {
                // Poll or wait for events with small delay
                val event = eventChannel.tryReceive().getOrNull()
                if (event != null) {
                    memoryBatch.add(event)
                }

                val now = System.currentTimeMillis()
                val shouldFlushByCount = memoryBatch.size >= BATCH_SIZE_TRIGGER
                val shouldFlushByTime = (now - lastFlushTime) >= FLUSH_INTERVAL_MS && memoryBatch.isNotEmpty()

                if (shouldFlushByCount || shouldFlushByTime) {
                    flushBatch(memoryBatch)
                    memoryBatch.clear()
                    lastFlushTime = System.currentTimeMillis()
                }

                if (event == null) {
                    delay(500)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "[CID] Exception in dispatch loop: ${t.message}")
                delay(1000)
            }
        }
    }

    private suspend fun flushPendingBatch(forceImmediate: Boolean = false) {
        val pending = mutableListOf<CidEventDto>()
        while (pending.size < MAX_BATCH_DISPATCH) {
            val ev = eventChannel.tryReceive().getOrNull() ?: break
            pending.add(ev)
        }
        if (pending.isNotEmpty()) {
            flushBatch(pending)
        }
    }

    private suspend fun flushBatch(eventsToSend: List<CidEventDto>) {
        val sessionId = currentSessionId.get()
        if (sessionId.isNullOrEmpty()) {
            // Save to spillover until active session is available
            saveToSpillover(eventsToSend)
            return
        }

        // Check if there are previously persisted spillover events
        val spilloverEvents = readSpillover()
        val combined = mutableListOf<CidEventDto>()

        // Prepend spillover events up to MAX_BATCH_DISPATCH
        val spilloverCountToTake = (MAX_BATCH_DISPATCH - eventsToSend.size).coerceAtLeast(0)
        val spilloverToUpload = spilloverEvents.take(spilloverCountToTake)
        val spilloverRemaining = spilloverEvents.drop(spilloverCountToTake)

        combined.addAll(spilloverToUpload)
        combined.addAll(eventsToSend)

        if (combined.isEmpty()) return

        // Take at most MAX_BATCH_DISPATCH
        val batchToUpload = combined.take(MAX_BATCH_DISPATCH)
        val overflowEvents = combined.drop(MAX_BATCH_DISPATCH)

        try {
            val response = cidService.postEvents(
                CidPostEventsRequestDto(
                    sessionId = sessionId,
                    events = batchToUpload
                )
            )

            if (response.isSuccessful && response.body()?.success == true) {
                Log.d(TAG, "[CID] Successfully uploaded ${batchToUpload.size} events.")
                // Update spillover file with whatever was left
                writeSpilloverDirect(overflowEvents + spilloverRemaining)
            } else {
                val code = response.code()
                val rawErrorBody = try {
                    response.errorBody()?.string() ?: ""
                } catch (_: Throwable) {
                    ""
                }
                val serverError = try {
                    val jsonObj = gson.fromJson(rawErrorBody, com.google.gson.JsonObject::class.java)
                    jsonObj.get("error")?.asString ?: rawErrorBody
                } catch (_: Throwable) {
                    rawErrorBody
                }

                Log.w(TAG, "[CID] Backend rejected events batch (HTTP $code): $serverError")

                when (code) {
                    400 -> {
                        if (serverError.contains("has expired or is inactive", ignoreCase = true)) {
                            // Expired session -> quarantine batch, update spillover, trigger renewal
                            saveToDeadLetter(batchToUpload)
                            writeSpilloverDirect(overflowEvents + spilloverRemaining)
                            CidDiagnosticManager.onSessionInvalidated()
                        } else {
                            // Malformed batch / schema validation error -> quarantine batch, unblock queue, DO NOT renew session
                            saveToDeadLetter(batchToUpload)
                            writeSpilloverDirect(overflowEvents + spilloverRemaining)
                            Log.w(TAG, "[CID] Malformed batch quarantined to dead letter. Retaining session.")
                        }
                    }
                    401 -> {
                        // Auth token expired -> keep batch in spillover for retry, pause dispatcher, DO NOT renew session
                        saveToSpillover(batchToUpload + overflowEvents)
                        pause()
                        Log.w(TAG, "[CID] Auth token expired (401). Dispatcher paused awaiting token refresh.")
                    }
                    403 -> {
                        if (serverError.contains("You do not own this diagnostic session", ignoreCase = true)) {
                            // Session ownership mismatch -> quarantine batch, update spillover, trigger renewal
                            saveToDeadLetter(batchToUpload)
                            writeSpilloverDirect(overflowEvents + spilloverRemaining)
                            CidDiagnosticManager.onSessionInvalidated()
                        } else {
                            // Insufficient role or other 403 -> quarantine batch, pause dispatcher, DO NOT renew session
                            saveToDeadLetter(batchToUpload)
                            writeSpilloverDirect(overflowEvents + spilloverRemaining)
                            pause()
                            Log.w(TAG, "[CID] User lacks authorized role for CID (403). Dispatcher paused.")
                        }
                    }
                    404 -> {
                        if (serverError.contains("Diagnostic session", ignoreCase = true) && serverError.contains("not found", ignoreCase = true)) {
                            // Session deleted on server -> quarantine batch, update spillover, trigger renewal
                            saveToDeadLetter(batchToUpload)
                            writeSpilloverDirect(overflowEvents + spilloverRemaining)
                            CidDiagnosticManager.onSessionInvalidated()
                        } else {
                            // Edge 404 / Route mismatch -> fatal URL misconfiguration, pause dispatcher, DO NOT renew session
                            saveToSpillover(batchToUpload + overflowEvents)
                            pause()
                            Log.e(TAG, "[CID] Fatal URL misconfiguration / Edge 404. Dispatcher paused.")
                        }
                    }
                    429 -> {
                        // Throttled by Cloudflare -> extract Retry-After, retain events in spillover, delay
                        val retryAfterSec = response.headers().get("Retry-After")?.toLongOrNull() ?: 30L
                        saveToSpillover(batchToUpload + overflowEvents)
                        Log.w(TAG, "[CID] Throttled by Cloudflare 429. Backing off for $retryAfterSec seconds.")
                        delay(retryAfterSec * 1000L)
                    }
                    else -> {
                        // 5xx / other status -> transient failure, save to spillover for retry with backoff
                        saveToSpillover(batchToUpload + overflowEvents)
                        delay(1000)
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[CID] Network exception during event dispatch: ${t.message}. Saving to offline spillover.")
            saveToSpillover(batchToUpload + overflowEvents)
            delay(1000)
        }
    }

    private suspend fun saveToSpillover(events: List<CidEventDto>) = spilloverMutex.withLock {
        try {
            val existing = readSpilloverInternal()
            val merged = (existing + events).takeLast(MAX_SPILLOVER_EVENTS)
            writeSpilloverInternal(merged)
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Failed to save events to spillover: ${t.message}")
        }
    }

    private suspend fun readSpillover(): List<CidEventDto> = spilloverMutex.withLock {
        readSpilloverInternal()
    }

    private fun readSpilloverInternal(): List<CidEventDto> {
        return try {
            if (!spilloverFile.exists()) return emptyList()
            val json = spilloverFile.readText(Charsets.UTF_8)
            val type = object : TypeToken<List<CidEventDto>>() {}.type
            gson.fromJson<List<CidEventDto>>(json, type) ?: emptyList()
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error reading spillover file: ${t.message}")
            emptyList()
        }
    }

    private suspend fun writeSpilloverDirect(events: List<CidEventDto>) = spilloverMutex.withLock {
        writeSpilloverInternal(events)
    }

    private fun writeSpilloverInternal(events: List<CidEventDto>) {
        try {
            if (events.isEmpty()) {
                if (spilloverFile.exists()) spilloverFile.delete()
                return
            }
            val json = gson.toJson(events)
            spilloverFile.writeText(json, Charsets.UTF_8)
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error writing spillover file: ${t.message}")
        }
    }

    private suspend fun saveToDeadLetter(events: List<CidEventDto>) = deadLetterMutex.withLock {
        try {
            val existing = readDeadLetterInternal()
            val merged = (existing + events).takeLast(MAX_DEAD_LETTER_EVENTS)
            writeDeadLetterInternal(merged)
            Log.w(TAG, "[CID] Quarantined ${events.size} events to dead letter (${merged.size} total in dead letter).")
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Failed to save events to dead letter: ${t.message}")
        }
    }

    private fun readDeadLetterInternal(): List<CidEventDto> {
        return try {
            if (!deadLetterFile.exists()) return emptyList()
            val json = deadLetterFile.readText(Charsets.UTF_8)
            val type = object : TypeToken<List<CidEventDto>>() {}.type
            gson.fromJson<List<CidEventDto>>(json, type) ?: emptyList()
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error reading dead letter file: ${t.message}")
            emptyList()
        }
    }

    private fun writeDeadLetterInternal(events: List<CidEventDto>) {
        try {
            if (events.isEmpty()) {
                if (deadLetterFile.exists()) deadLetterFile.delete()
                return
            }
            val json = gson.toJson(events)
            val bytes = json.toByteArray(Charsets.UTF_8)
            if (bytes.size > MAX_DEAD_LETTER_BYTES) {
                val trimmed = events.takeLast((events.size / 2).coerceAtLeast(1))
                val trimmedJson = gson.toJson(trimmed)
                deadLetterFile.writeText(trimmedJson, Charsets.UTF_8)
            } else {
                deadLetterFile.writeText(json, Charsets.UTF_8)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error writing dead letter file: ${t.message}")
        }
    }
}
