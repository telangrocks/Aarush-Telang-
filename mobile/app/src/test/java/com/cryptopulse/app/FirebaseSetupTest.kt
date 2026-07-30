package com.cryptopulse.app

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FirebaseSetupTest {

    @Test
    fun testGoogleServicesJsonStructureAndPackageName() {
        val jsonFile = File("google-services.json")
        assertTrue("google-services.json must exist in mobile/app", jsonFile.exists())

        val jsonContent = jsonFile.readText()
        val jsonObject = JsonParser.parseString(jsonContent).asJsonObject

        val projectInfo = jsonObject.getAsJsonObject("project_info")
        assertEquals("324707004601", projectInfo.get("project_number").asString)
        assertEquals("cryptopulse-71537", projectInfo.get("project_id").asString)

        val clients = jsonObject.getAsJsonArray("client")
        assertTrue("Client list must not be empty", clients.size() > 0)

        var foundMainPackage = false
        for (i in 0 until clients.size()) {
            val client = clients.get(i).asJsonObject
            val clientInfo = client.getAsJsonObject("client_info")
            val androidClientInfo = clientInfo.getAsJsonObject("android_client_info")
            val packageName = androidClientInfo.get("package_name").asString

            if (packageName == "com.cryptopulse.app") {
                foundMainPackage = true
                val appId = clientInfo.get("mobilesdk_app_id").asString
                assertTrue("App ID should start with 1:324707004601", appId.startsWith("1:324707004601"))

                val apiKeys = client.getAsJsonArray("api_key")
                assertTrue("API key array must not be empty", apiKeys.size() > 0)
                val currentKey = apiKeys.get(0).asJsonObject.get("current_key").asString
                assertTrue("Current key must not be empty", currentKey.isNotBlank())
            }
        }

        assertTrue("google-services.json must contain client for com.cryptopulse.app", foundMainPackage)
    }
}
