// src/handlers/market.ts
import { Context } from 'hono';
import { Env } from '../index';

interface CoinGeckoMarket {
    id: string;
    symbol: string;
    name: string;
    current_price: number;
    total_volume: number;
    price_change_percentage_24h: number;
}

/**
 * A simple "AI" analysis engine.
 * Fetches top 100 coins, filters by volume, and sorts by 24h price change
 * to find the top 10 most volatile trading candidates.
 */
export async function handleGetMarketCandidates(c: Context<{ Bindings: Env }>): Promise<Response> {
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false');
        if (!response.ok) {
            return c.json({ error: 'Failed to fetch market data from external API' }, { status: response.status });
        }
        const data = (await response.json()) as CoinGeckoMarket[];

        const candidates = data
            // Filter for coins with significant volume (e.g., > $1M)
            .filter(coin => coin.total_volume > 1000000)
            // Sort by the absolute value of the 24h price change to find most volatile
            .sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h))
            // Take the top 10
            .slice(0, 10)
            // Format the response
            .map(coin => ({
                coinName: coin.name,
                symbol: coin.symbol.toUpperCase(),
                currentMarketPrice: coin.current_price,
                minTradingNotional: 100.0 // This would typically come from the exchange
            }));

        return c.json(candidates);
    } catch (err: unknown) {
        const error = err as Error;
        return c.json({ error: 'Error processing market data', message: error.message }, 500);
    }
}