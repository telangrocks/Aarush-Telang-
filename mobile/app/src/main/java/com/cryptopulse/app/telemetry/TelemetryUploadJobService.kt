package com.cryptopulse.app.telemetry

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * OS-scheduled background uploader for persisted Stage 9 Android telemetry events.
 * Uses Android's native `JobScheduler` (API 26+) with `NETWORK_TYPE_ANY` and exponential backoff
 * so failed uploads retry off the main/trading path without extra dependencies.
 */
class TelemetryUploadJobService : JobService() {

    private var activeJob: Job? = null
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onStartJob(params: JobParameters?): Boolean {
        activeJob = serviceScope.launch {
            val drainedCleanly = try {
                AndroidStage9Observer.flushPendingSync()
            } catch (_: Throwable) {
                false
            }
            // If backlog still needs retry (e.g. network or auth transiently unavailable), reschedule with backoff
            try {
                jobFinished(params, !drainedCleanly)
            } catch (_: Throwable) {
                // Service may already be stopped
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        activeJob?.cancel()
        return AndroidStage9Observer.pendingCount() > 0
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }

    companion object {
        private const val JOB_ID = 9091

        fun schedule(context: Context, minLatencyMs: Long = 1_500L, initialBackoffMs: Long = 15_000L) {
            try {
                val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
                val component = ComponentName(context, TelemetryUploadJobService::class.java)
                val info = JobInfo.Builder(JOB_ID, component)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setMinimumLatency(minLatencyMs.coerceAtLeast(0L))
                    .setOverrideDeadline((minLatencyMs + 120_000L).coerceAtLeast(15_000L))
                    .setBackoffCriteria(initialBackoffMs.coerceAtLeast(10_000L), JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .build()
                scheduler.schedule(info)
            } catch (_: Throwable) {
                // Strictly fail-open: never impact foreground app startup or alert UX
            }
        }
    }
}
