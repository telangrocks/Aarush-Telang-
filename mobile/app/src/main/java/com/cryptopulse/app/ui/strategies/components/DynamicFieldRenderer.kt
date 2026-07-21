package com.cryptopulse.app.ui.strategies.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.domain.models.DynamicFieldModel
import com.cryptopulse.app.domain.models.ParameterType
import com.cryptopulse.app.ui.theme.CyanPrimary
import com.cryptopulse.app.ui.theme.LossRed
import com.cryptopulse.app.ui.theme.TextPrimary
import com.cryptopulse.app.ui.theme.TextSecondary

@Composable
fun DynamicFieldRenderer(
    field: DynamicFieldModel,
    currentValue: String,
    error: String?,
    onValueChange: (String) -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        when (field.type) {
            ParameterType.INT, ParameterType.DOUBLE -> {
                NumericField(field, currentValue, error, onValueChange)
            }
            ParameterType.BOOLEAN -> {
                BooleanField(field, currentValue, error, onValueChange)
            }
            ParameterType.ENUM -> {
                EnumField(field, currentValue, error, onValueChange)
            }
        }
        
        if (error != null) {
            Text(
                text = error,
                color = LossRed,
                fontSize = 12.sp,
                modifier = Modifier.padding(start = 16.dp, top = 4.dp)
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NumericField(
    field: DynamicFieldModel,
    currentValue: String,
    error: String?,
    onValueChange: (String) -> Unit
) {
    val isError = error != null
    OutlinedTextField(
        value = currentValue,
        onValueChange = onValueChange,
        label = { Text(field.displayName) },
        modifier = Modifier.fillMaxWidth(),
        isError = isError,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = TextPrimary,
            unfocusedTextColor = TextPrimary,
            cursorColor = CyanPrimary,
            focusedBorderColor = CyanPrimary,
            unfocusedBorderColor = Color(0xFF2A3650),
            errorBorderColor = LossRed
        )
    )
}

@Composable
fun BooleanField(
    field: DynamicFieldModel,
    currentValue: String,
    error: String?,
    onValueChange: (String) -> Unit
) {
    val checked = currentValue.toBooleanStrictOrNull() ?: false
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(text = field.displayName, color = TextPrimary)
        Switch(
            checked = checked,
            onCheckedChange = { onValueChange(it.toString()) },
            colors = SwitchDefaults.colors(checkedThumbColor = CyanPrimary, checkedTrackColor = Color(0xFF0D1E3A))
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EnumField(
    field: DynamicFieldModel,
    currentValue: String,
    error: String?,
    onValueChange: (String) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = !expanded }
    ) {
        OutlinedTextField(
            value = currentValue,
            onValueChange = {},
            readOnly = true,
            label = { Text(field.displayName) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor().fillMaxWidth(),
            isError = error != null,
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = TextPrimary,
                unfocusedTextColor = TextPrimary,
                focusedBorderColor = CyanPrimary,
                unfocusedBorderColor = Color(0xFF2A3650)
            )
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            field.options?.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option) },
                    onClick = {
                        onValueChange(option)
                        expanded = false
                    }
                )
            }
        }
    }
}
