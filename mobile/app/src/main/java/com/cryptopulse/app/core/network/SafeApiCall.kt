package com.cryptopulse.app.core.network

import com.cryptopulse.app.core.error.NetworkError
import org.json.JSONObject
import retrofit2.HttpException
import java.io.IOException
import java.net.SocketTimeoutException
import kotlinx.coroutines.CancellationException

data class ParsedErrorInfo(
    val message: String,
    val hint: String? = null,
    val errorCode: String? = null,
    val exchangeCode: String? = null,
    val correlationId: String? = null,
    val detail: String? = null
)

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
            val info = extractErrorInfo(response.errorBody()?.string(), response.message())
            val error = when (response.code()) {
                401 -> NetworkError.Unauthorized
                403 -> NetworkError.Forbidden
                404 -> NetworkError.NotFound
                else -> NetworkError.HttpError(
                    code = response.code(),
                    message = info.message,
                    hint = info.hint,
                    errorCode = info.errorCode,
                    exchangeCode = info.exchangeCode,
                    correlationId = info.correlationId,
                    detail = info.detail
                )
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
                val info = extractErrorInfo(e.response()?.errorBody()?.string(), e.message())
                val error = when (code) {
                    401 -> NetworkError.Unauthorized
                    403 -> NetworkError.Forbidden
                    404 -> NetworkError.NotFound
                    else -> NetworkError.HttpError(
                        code = code,
                        message = info.message,
                        hint = info.hint,
                        errorCode = info.errorCode,
                        exchangeCode = info.exchangeCode,
                        correlationId = info.correlationId,
                        detail = info.detail
                    )
                }
                NetworkResult.Error(error)
            }
            else -> NetworkResult.Error(NetworkError.Unknown(e))
        }
    }
}

private fun extractErrorInfo(errorBody: String?, fallbackMessage: String?): ParsedErrorInfo {
    val fallback = if (fallbackMessage.isNullOrBlank()) "Unknown Error" else fallbackMessage
    if (errorBody.isNullOrBlank()) return ParsedErrorInfo(message = fallback)
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
        val errorCode = if (json.has("code")) json.getString("code") else null
        val exchangeCode = if (json.has("exchangeCode")) json.get("exchangeCode").toString() else null
        val correlationId = if (json.has("correlationId")) json.getString("correlationId") else null
        val detail = if (json.has("detail")) json.getString("detail") else null
        ParsedErrorInfo(
            message = message,
            hint = hint,
            errorCode = errorCode,
            exchangeCode = exchangeCode,
            correlationId = correlationId,
            detail = detail
        )
    } catch (e: Exception) {
        ParsedErrorInfo(message = fallback)
    }
}
