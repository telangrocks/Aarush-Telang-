package com.cryptopulse.app.domain.models

open class DomainException(
    override val message: String,
    val hint: String? = null,
    val code: String? = null,
    val details: String? = null,
    val exchangeCode: Int? = null,
    cause: Throwable? = null
) : Exception(message, cause)
