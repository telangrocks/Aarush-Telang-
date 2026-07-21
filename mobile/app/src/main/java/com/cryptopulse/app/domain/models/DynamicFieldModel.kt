package com.cryptopulse.app.domain.models

data class DynamicFieldModel(
    val key: String,
    val displayName: String,
    val type: ParameterType,
    val defaultValue: String,
    val isRequired: Boolean,
    val minValue: Double? = null,
    val maxValue: Double? = null,
    val options: List<String>? = null
)

// Extension to map from Backend Contract to UI Domain Model
fun StrategyParameterSchema.toDynamicFieldModel(): DynamicFieldModel {
    return DynamicFieldModel(
        key = this.key,
        displayName = this.displayName,
        type = this.type,
        defaultValue = this.defaultValue,
        isRequired = this.isRequired,
        minValue = this.minValue,
        maxValue = this.maxValue,
        options = this.options
    )
}
