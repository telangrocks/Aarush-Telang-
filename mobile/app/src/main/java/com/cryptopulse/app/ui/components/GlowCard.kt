package com.cryptopulse.app.ui.components

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.cryptopulse.app.ui.theme.CyanGlow
import com.cryptopulse.app.ui.theme.CyanPrimary
import com.cryptopulse.app.ui.theme.NavyCard

/**
 * A dark card surface with a subtle glowing cyan/blue border,
 * matching the section cards in the reference designs.
 *
 * @param modifier       Outer modifier applied to the card
 * @param borderColor    Primary border colour (defaults to CyanPrimary)
 * @param cornerRadius   Corner radius of the card
 * @param content        Composable content placed inside the card
 */
@Composable
fun GlowCard(
    modifier: Modifier = Modifier,
    borderColor: Color = CyanPrimary,
    cornerRadius: Dp = 14.dp,
    content: @Composable BoxScope.() -> Unit,
) {
    val glowBrush = Brush.verticalGradient(
        colors = listOf(
            borderColor.copy(alpha = 0.6f),
            borderColor.copy(alpha = 0.25f),
        )
    )

    Surface(
        color = NavyCard,
        shape = RoundedCornerShape(cornerRadius),
        modifier = modifier
            .fillMaxWidth()
            .border(
                width = 1.dp,
                brush = glowBrush,
                shape = RoundedCornerShape(cornerRadius)
            )
    ) {
        Box(
            modifier = Modifier.padding(16.dp),
            content = content
        )
    }
}

/**
 * Variant with a custom border colour — used for Stop Loss cards (red) and
 * Take Profit cards (green).
 */
@Composable
fun ColoredGlowCard(
    modifier: Modifier = Modifier,
    borderColor: Color,
    cornerRadius: Dp = 14.dp,
    content: @Composable BoxScope.() -> Unit,
) = GlowCard(
    modifier      = modifier,
    borderColor   = borderColor,
    cornerRadius  = cornerRadius,
    content       = content,
)
