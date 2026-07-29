package com.cryptopulse.app.utils

import android.graphics.Bitmap
import android.os.Environment
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import java.io.File
import java.io.FileOutputStream

object ScreenshotUtil {
    private const val TAG = "ScreenshotUtil"

    fun captureScreenshot(name: String): String? {
        return try {
            val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val dir = File(context.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
            val file = File(dir, "$name.png")
            val success = device.takeScreenshot(file)
            if (success) {
                Log.i(TAG, "Screenshot saved successfully: ${file.absolutePath}")
                file.absolutePath
            } else {
                Log.e(TAG, "Failed to capture screenshot: $name")
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception while capturing screenshot: ${e.message}", e)
            null
        }
    }
}

class ScreenshotTestRule : TestWatcher() {
    override fun succeeded(description: Description) {
        ScreenshotUtil.captureScreenshot("${description.methodName}_final_state")
    }

    override fun failed(e: Throwable?, description: Description) {
        ScreenshotUtil.captureScreenshot("${description.methodName}_failure")
    }
}
