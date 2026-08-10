package com.cryptopulse.app.core.network

import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.domain.models.DomainException

sealed interface NetworkResult<out T> {
    data class Success<out T>(val data: T) : NetworkResult<T>
    data class Error(val error: NetworkError) : NetworkResult<Nothing>
}

inline fun <T> NetworkResult<T>.onSuccess(action: (value: T) -> Unit): NetworkResult<T> {
    if (this is NetworkResult.Success) {
        action(this.data)
    }
    return this
}

inline fun <T> NetworkResult<T>.onFailure(action: (exception: Throwable) -> Unit): NetworkResult<T> {
    if (this is NetworkResult.Error) {
        val throwable = when (val error = this.error) {
            is NetworkError.HttpError -> DomainException(
                message = error.message.ifBlank { "HTTP Error ${error.code}" },
                hint = error.hint,
                code = error.errorCode,
                details = error.detail,
                exchangeCode = error.exchangeCode?.toIntOrNull()
            )
            is NetworkError.Unauthorized -> DomainException(message = "Session expired", code = "Unauthorized")
            is NetworkError.Unknown -> error.error
            else -> Exception("Network error: $error")
        }
        action(throwable)
    }
    return this
}

inline fun <T> NetworkResult<T>.getOrNull(): T? {
    return if (this is NetworkResult.Success) this.data else null
}

inline fun <T> NetworkResult<T>.exceptionOrNull(): Throwable? {
    if (this is NetworkResult.Error) {
        return when (val error = this.error) {
            is NetworkError.HttpError -> DomainException(
                message = error.message.ifBlank { "HTTP Error ${error.code}" },
                hint = error.hint,
                code = error.errorCode,
                details = error.detail,
                exchangeCode = error.exchangeCode?.toIntOrNull()
            )
            is NetworkError.Unauthorized -> DomainException(message = "Session expired", code = "Unauthorized")
            is NetworkError.Unknown -> error.error
            else -> Exception("Network error: $error")
        }
    }
    return null
}

val <T> NetworkResult<T>.isSuccess: Boolean
    get() = this is NetworkResult.Success

val <T> NetworkResult<T>.isFailure: Boolean
    get() = this is NetworkResult.Error
