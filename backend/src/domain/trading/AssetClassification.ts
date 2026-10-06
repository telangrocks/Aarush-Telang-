/**
 * Canonical Asset Classification & Filtering Engine
 *
 * Single authoritative source of truth for asset classification across CryptoPulse:
 * - Stablecoin filtering
 * - Leveraged / inverse token filtering
 * - Commodity instrument filtering (ISO 4217 precious metals & energy linear contracts)
 *
 * Preserves dynamic discovery: No whitelist of native crypto tokens is used.
 * Standard crypto tokens (BTC, ETH, SOL, etc.) and ETF perpetuals (SOXL) remain eligible.
 */

export const STABLECOINS: ReadonlySet<string> = new Set([
  'USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'USDP',
  'USDE', 'PYUSD', 'FRAX', 'USDD', 'GUSD', 'USDJ', 'EURT',
  'USDY', 'LUSD', 'CRVUSD',
]);

export const LEVERAGED_TOKEN_REGEX = /.*(2L|3L|4L|5L|10L|2S|3S|4S|5S|10S|UP|DOWN|BULL|BEAR)(USDT|USDC|DAI)?$/i;

/**
 * Commodity base assets explicitly excluded from Linear Perpetual universe.
 * Note: Bybit V5 Linear instruments classify commodities under category="linear"
 * and contractType="LinearPerpetual" alongside crypto. Therefore, commodity exclusion
 * is enforced by base asset identification.
 */
export const COMMODITY_BASE_ASSETS: ReadonlySet<string> = new Set([
  'XAU',   // Gold
  'XAG',   // Silver
  'XPT',   // Platinum
  'XPD',   // Palladium
  'USOIL', // WTI Crude Oil
  'BRENT', // Brent Crude Oil
]);

const KNOWN_QUOTES = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'EUR', 'INR'] as const;

/**
 * Extracts canonical base asset from symbol string formatted as:
 * - "BTC/USDT" -> "BTC"
 * - "BTC-USDT" -> "BTC"
 * - "BTC_USDT" -> "BTC"
 * - "BTCUSDT"  -> "BTC"
 * - "SOXLUSDT" -> "SOXL"
 * - "XAUUSDT"  -> "XAU"
 */
export function extractBaseAsset(symbol: string): string {
  if (!symbol) return '';
  const clean = symbol.trim().toUpperCase();
  if (clean.includes('/')) return clean.split('/')[0];
  if (clean.includes('-')) return clean.split('-')[0];
  if (clean.includes('_')) return clean.split('_')[0];
  for (const q of KNOWN_QUOTES) {
    if (clean.endsWith(q) && clean.length > q.length) {
      return clean.slice(0, clean.length - q.length);
    }
  }
  return clean;
}

/**
 * Canonical exclusion predicate.
 * Returns true if an asset must be excluded from scanning, candidate pools, and execution.
 */
export function isExcludedAsset(symbolStr: string): boolean {
  if (!symbolStr) return true;
  const clean = String(symbolStr).trim().toUpperCase();
  const base = extractBaseAsset(clean);

  // 1. Stablecoins
  if (STABLECOINS.has(clean) || STABLECOINS.has(base)) {
    return true;
  }

  // 2. Commodities (Gold, Silver, Platinum, Palladium, Oil)
  if (COMMODITY_BASE_ASSETS.has(base) || COMMODITY_BASE_ASSETS.has(clean)) {
    return true;
  }

  // 3. Leveraged / Inverse Tokens
  if (LEVERAGED_TOKEN_REGEX.test(clean) || LEVERAGED_TOKEN_REGEX.test(base)) {
    return true;
  }

  return false;
}
