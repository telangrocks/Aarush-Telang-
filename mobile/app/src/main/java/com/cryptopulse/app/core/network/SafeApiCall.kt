package com.cryptopulse.app.core.network

import com.cryptopulse.app.core.error.NetworkError
import org.json.JSONObject
import retrofit2.HttpException
import java.io.IOException
import java.net.SocketTimeoutException
import kotlinx.coroutines.CancellationException

suspend fun <T> safeApiCall(apiCall: suspend () -> retrofit2.Response<T>): NetworkResult<T> {
    return try {
        val response = apiCall()
        if (response.isSuccessful) {
            val body = response.body()
            if (body != null) {
                NetworkResult.Success(body)
            } else {
                NetworkResult.Error(NetworkError.Unknown(Exception("Empty response body")))
            }
        } else {
            val (errorMsg, hint) = extractErrorAndHint(response.errorBody()?.string(), response.message())
            val error = when (response.code()) {
                401 -> NetworkError.Unauthorized
                403 -> NetworkError.Forbidden
                404 -> NetworkError.NotFound
                else -> NetworkError.HttpError(response.code(), errorMsg, hint)
            }
            NetworkResult.Error(error)
        }
    } catch (e: Exception) {
        when (e) {
            is CancellationException -> throw e
            is SocketTimeoutException -> NetworkResult.Error(NetworkError.Timeout)
            is IOException -> NetworkResult.Error(NetworkError.Unknown(e))
            is HttpException -> {
                val code = e.code()
                val (errorMsg, hint) = extractErrorAndHint(e.response()?.errorBody()?.string(), e.message())
                val error = when (code) {
                    401 -> NetworkError.Unauthorized
                    403 -> NetworkError.Forbidden
                    404 -> NetworkError.NotFound
                    else -> NetworkError.HttpError(code, errorMsg, hint)
                }
                NetworkResult.Error(error)
            }
            else -> NetworkResult.Error(NetworkError.Unknown(e))
        }
    }
}

private fun extractErrorAndHint(errorBody: String?, fallbackMessage: String?): Pair<String, String?> {
    val fallback = if (fallbackMessage.isNullOrBlank()) "Unknown Error" else fallbackMessage
    if (errorBody.isNullOrBlank()) return fallback to null
    return try {
        val json = JSONObject(errorBody)
        val message = if (json.has("message")) {
            json.getString("message")
        } else if (json.has("error")) {
            json.getString("error")
        } else {
            fallback
        }
        val hint = if (json.has("hint")) json.getString("hint") else null
        message to hint
    } catch (e: Exception) {
        fallback to null
    }
}
