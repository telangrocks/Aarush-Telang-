package com.cryptopulse.app.core.error

sealed interface NetworkError {
    data class HttpError(val code: Int, val message: String, val hint: String? = null) : NetworkError
    object Unauthorized : NetworkError
    object Forbidden : NetworkError
    object NotFound : NetworkError
    object Timeout : NetworkError
    object Serialization : NetworkError
    data class Unknown(val error: Throwable) : NetworkError
}
