package com.cryptopulse.app.data.api.dto.fcm.request

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmRegisterRequestDtoTest {

    private val gson = Gson()

    @Test
    fun `FcmRegisterRequestDto serializes exactly to fcmToken field matching backend contract`() {
        val testToken = "sample_firebase_token_abc123"
        val dto = FcmRegisterRequestDto(fcmToken = testToken)

        val json = gson.toJson(dto)

        // Assert JSON has "fcmToken": "sample_firebase_token_abc123"
        assertTrue("JSON must contain fcmToken key", json.contains("\"fcmToken\":\"$testToken\""))
        assertEquals("{\"fcmToken\":\"$testToken\"}", json)
    }

    @Test
    fun `FcmRegisterRequestDto deserializes correctly from backend format`() {
        val json = "{\"fcmToken\":\"sample_token_xyz789\"}"
        val dto = gson.fromJson(json, FcmRegisterRequestDto::class.java)

        assertEquals("sample_token_xyz789", dto.fcmToken)
    }
}
