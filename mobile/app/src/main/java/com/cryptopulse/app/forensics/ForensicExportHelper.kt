package com.cryptopulse.app.forensics

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/**
 * Utility to verify, inspect, and export the 4-hour forensic files.
 */
object ForensicExportHelper {

    fun getLogFile(context: Context): File {
        val externalDir = context.getExternalFilesDir(null)
        val candidate = File(externalDir, ForensicDiskWriter.JSONL_FILENAME)
        return if (candidate.exists()) candidate else File(context.filesDir, ForensicDiskWriter.JSONL_FILENAME)
    }

    fun getSummaryFile(context: Context): File {
        val externalDir = context.getExternalFilesDir(null)
        val candidate = File(externalDir, ForensicDiskWriter.SUMMARY_FILENAME)
        return if (candidate.exists()) candidate else File(context.filesDir, ForensicDiskWriter.SUMMARY_FILENAME)
    }

    fun getFormattedStatus(context: Context): String {
        val logFile = getLogFile(context)
        val summaryFile = getSummaryFile(context)

        val logSizeKb = if (logFile.exists()) logFile.length() / 1024.0 else 0.0
        val summarySizeKb = if (summaryFile.exists()) summaryFile.length() / 1024.0 else 0.0
        val cycles = ShrikantTelang_ForensicCID.getTotalCyclesRecorded()

        return """
            === ShrikantTelang_ForensicCID Status ===
            Total Cycles Captured: $cycles
            Log File: ${logFile.absolutePath} (${String.format("%.2f", logSizeKb)} KB)
            Summary File: ${summaryFile.absolutePath} (${String.format("%.2f", summarySizeKb)} KB)
            ADB Pull Command:
            adb pull ${logFile.absolutePath} .
            adb pull ${summaryFile.absolutePath} .
        """.trimIndent()
    }

    fun createShareIntent(context: Context, file: File): Intent? {
        if (!file.exists()) return null
        return try {
            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } catch (e: Exception) {
            Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, Uri.fromFile(file))
            }
        }
    }
}
