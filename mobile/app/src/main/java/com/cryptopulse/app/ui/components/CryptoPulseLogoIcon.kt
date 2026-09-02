package com.cryptopulse.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.cryptopulse.app.R

/**
 * Standardized CryptoPulse Master Logo icon component.
 * Renders the refurbished C-Arc + Pulse Waveform + Data-Dot vector mark.
 */
@Composable
fun CryptoPulseLogoIcon(
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    contentDescription: String = "CryptoPulse Logo",
) {
    Image(
        painter = painterResource(id = R.drawable.ic_cryptopulse_logo),
        contentDescription = contentDescription,
        contentScale = ContentScale.Fit,
        modifier = modifier.size(size)
    )
}
