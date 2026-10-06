package com.cryptopulse.app.service

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class TradeAlertAudioManager(
    private val context: Context,
    private val audioProvider: AlertAudioProvider = DefaultAlertAudioProvider()
) {
    private var mediaPlayer: MediaPlayer? = null
    private val audioManager: AudioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private var fadeJob: Job? = null
    private var audioTimeoutJob: Job? = null
    private var isPlaying = false

    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                pausePlayback()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                mediaPlayer?.setVolume(0.2f, 0.2f)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                mediaPlayer?.setVolume(1.0f, 1.0f)
                if (isPlaying) mediaPlayer?.start()
            }
        }
    }

    @Synchronized
    fun startAlert(voicePack: AlertVoicePack = AlertVoicePack.FEMALE_EN_V1) {
        if (isPlaying && mediaPlayer?.isPlaying == true) {
            TradeAlertLogger.log("AUDIO_ALREADY_PLAYING", "Voice looper is already active; continuing playback")
            return
        }

        try {
            requestAudioFocus()
            val resId = audioProvider.getAudioResourceId(context, voicePack)
            if (resId == 0) {
                TradeAlertLogger.log("AUDIO_RESOURCE_NOT_FOUND", "Raw audio resource for $voicePack not found")
                return
            }

            fadeJob?.cancel()
            audioTimeoutJob?.cancel()
            val oldPlayer = mediaPlayer
            mediaPlayer = null
            if (oldPlayer != null) {
                try {
                    oldPlayer.setOnCompletionListener(null)
                    oldPlayer.setOnErrorListener(null)
                    if (oldPlayer.isPlaying) oldPlayer.stop()
                    oldPlayer.release()
                } catch (e: Exception) {
                    TradeAlertLogger.error("AUDIO_CLEANUP_ERROR", e)
                }
            }

            val afd = context.resources.openRawResourceFd(resId) ?: run {
                TradeAlertLogger.log("AUDIO_RESOURCE_NOT_FOUND", "Raw audio resource descriptor for $voicePack was null")
                return
            }

            val newPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                afd.use { descriptor ->
                    setDataSource(descriptor.fileDescriptor, descriptor.startOffset, descriptor.length)
                }
                isLooping = true
                setVolume(0.0f, 0.0f)
                setOnErrorListener { _, what, extra ->
                    TradeAlertLogger.error("MEDIA_PLAYER_ERROR", Exception("MediaPlayer playback error: what=$what extra=$extra"))
                    stopAlert()
                    true
                }
                prepare()
                start()
            }
            mediaPlayer = newPlayer
            isPlaying = true
            TradeAlertLogger.log("AUDIO_STARTED", "Custom female voice alert playing (bounded by 30s watchdog)")

            // 200ms Volume Fade-In
            fadeJob = scope.launch {
                val steps = 10
                val delayTime = 20L
                for (i in 1..steps) {
                    val vol = i / steps.toFloat()
                    try {
                        newPlayer.setVolume(vol, vol)
                    } catch (_: Exception) {}
                    delay(delayTime)
                }
            }

            // Centralized Hardware Lifetime Watchdog
            audioTimeoutJob = scope.launch {
                delay(TradeAlertManager.TRADE_ALERT_HARDWARE_TIMEOUT_MS)
                TradeAlertLogger.log("AUDIO_WATCHDOG_TIMEOUT", "Audio playback reached 30s limit; stopping automatically.")
                stopAlert()
            }
        } catch (e: Exception) {
            isPlaying = false
            TradeAlertLogger.error("AUDIO_START_ERROR", e)
        }
    }

    private fun pausePlayback() {
        try {
            if (mediaPlayer?.isPlaying == true) {
                mediaPlayer?.pause()
                TradeAlertLogger.log("AUDIO_PAUSED", "Transient audio focus loss")
            }
        } catch (e: Exception) {
            TradeAlertLogger.error("AUDIO_PAUSE_ERROR", e)
        }
    }

    @Synchronized
    fun stopAlert() {
        audioTimeoutJob?.cancel()
        audioTimeoutJob = null

        if (!isPlaying && mediaPlayer == null) return
        isPlaying = false

        fadeJob?.cancel()
        val playerToStop = mediaPlayer
        mediaPlayer = null

        fadeJob = scope.launch {
            try {
                if (playerToStop != null) {
                    // 200ms Volume Fade-Out
                    val steps = 10
                    val delayTime = 20L
                    for (i in steps downTo 0) {
                        val vol = i / steps.toFloat()
                        try {
                            playerToStop.setVolume(vol, vol)
                        } catch (_: Exception) {}
                        delay(delayTime)
                    }
                    playerToStop.setOnCompletionListener(null)
                    playerToStop.setOnErrorListener(null)
                    try {
                        if (playerToStop.isPlaying) {
                            playerToStop.stop()
                        }
                    } catch (_: Exception) {}
                    playerToStop.release()
                }
                abandonAudioFocus()
                TradeAlertLogger.log("AUDIO_STOPPED", "Audio alert stopped and released with smooth fade-out")
            } catch (e: Exception) {
                TradeAlertLogger.error("AUDIO_STOP_ERROR", e)
                try {
                    playerToStop?.setOnCompletionListener(null)
                    playerToStop?.setOnErrorListener(null)
                    playerToStop?.release()
                } catch (_: Exception) {}
                abandonAudioFocus()
            }
        }
    }

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val playbackAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(playbackAttributes)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .build()
            audioManager.requestAudioFocus(audioFocusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_ALARM,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusChangeListener)
        }
    }
}
