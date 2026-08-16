package com.cryptopulse.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.cryptopulse.app.R

/**
 * High-resolution CryptoPulse 3D Bull & HUD logo icon component.
 * Renders the dedicated app_logo launcher resource with rounded corner clipping.
 */
@Composable
fun CryptoPulseLogoIcon(
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    primaryColor: Color = Color(0xFF00F0FF),
    accentColor: Color = Color(0xFF7000FF),
    secondaryColor: Color = Color(0xFF00FF9D),
) {
    Image(
        painter = painterResource(id = R.drawable.ic_cryptopulse_logo),
        contentDescription = "CryptoPulse Logo",
        contentScale = ContentScale.Crop,
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.22f))
    )
}
