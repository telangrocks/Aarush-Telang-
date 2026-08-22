package com.cryptopulse.app.data.api

object ApiConstants {
    const val LOGIN = "/api/login"
    const val REGISTER = "/api/register"
    const val LOGOUT = "/api/logout"
    const val REFRESH = "/api/refresh"

    const val EXCHANGE_VALIDATE = "/api/exchange/validate"
    const val EXCHANGE_CONNECT = "/api/exchange/connect"
    const val EXCHANGE_STATUS = "/api/exchange/status"
    const val EXCHANGE_BALANCE = "/api/exchange/balance"

    const val MARKET_CANDIDATES = "/api/market/candidates"
    const val MARKET_KLINES = "/api/market/klines"
    const val MARKET_TICKER = "/api/market/ticker"
    const val MARKET_TECHNICAL_ANALYSIS = "/api/market/technical-analysis"

    const val BOT_ACTIVATE = "/api/trading-bot/activate"
    const val BOT_DEACTIVATE = "/api/trading-bot/deactivate"
    const val BOT_STATUS = "/api/trading-bot/status"
    const val BOT_ANALYSIS_STATUS = "/api/trading-bot/analysis-status"
    const val BOT_EXECUTE_TRADE = "/api/trading-bot/execute-trade"
    const val BOT_MOCK_TRADE = "/api/trading-bot/mock-trade"
    const val BOT_STOP_TRADE = "/api/trading-bot/stop-trade"
    const val BOT_ALERTS = "/api/trading-bot/alerts"
    const val BOT_ALERTS_ACKNOWLEDGE = "/api/trading-bot/alerts/acknowledge"
    const val BOT_EXECUTION_STATUS = "/api/trading-bot/execution-status/{positionId}"

    const val FCM_REGISTER = "/api/fcm/register"
}
