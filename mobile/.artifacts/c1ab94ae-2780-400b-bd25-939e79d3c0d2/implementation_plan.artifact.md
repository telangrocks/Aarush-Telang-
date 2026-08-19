# Implementation Plan - Testing & Verifying Account Balance Logic

This plan focuses on validating the account balance fetching logic in the `TradeSetup` flow, specifically ensuring it works correctly in both "Demo" and "Real" modes.

## User Review Required

> [!WARNING]
> The preliminary audit suggests a potential bug: the account balance might not be fetched automatically when entering the `TradeSetup` screen, leading to a "Fetching wallet balance..." hang unless the user visits the `Portfolio` screen first.

## Proposed Changes

### Research & Verification

#### [MODIFY] [ExchangeBalanceTest.kt](file:///C:/CryptoPulse New/mobile/app/src/test/java/com/cryptopulse/app/ui/auth/ExchangeBalanceTest.kt) [NEW]
I will create a unit test to verify that `ExchangeViewModel.fetchBalances()` correctly handles API responses and populates the UI state. This will include:
- Successful balance fetch (Demo & Real mocked data).
- Network error handling.
- Empty balance handling.

#### [MODIFY] [TradeSetupBalanceIntegrationTest.kt](file:///C:/CryptoPulse New/mobile/app/src/androidTest/java/com/cryptopulse/app/integration/TradeSetupBalanceIntegrationTest.kt) [NEW]
I will create an integration test (using Compose Rule) to verify that when navigating to the `TradeSetupScreen`, the balance is actually fetched and displayed without manual user intervention.

### Logic Audit (Trace)

1.  **Backend Session Affinity**: Verify that the backend correctly routes `GET /api/exchange/balance` to either the Demo or Mainnet Bybit API based on the `environment` parameter sent during the last `POST /api/exchange/connect`.
2.  **Trigger Audit**: Identify the exact point where `fetchBalances()` *should* be called in the `TradeSetup` flow (e.g., in `TradeSetupScreen`'s `LaunchedEffect` or in `MainActivity`'s navigation transition).

## Verification Plan

### Automated Tests
- Run `ExchangeBalanceTest` to verify `ExchangeViewModel` state management.
- Run `TradeSetupBalanceIntegrationTest` to verify the UI correctly displays the balance.

### Manual Verification
- Deploy the app in **Demo Mode**. Navigate to `TradeSetup`. Verify the demo balance appears (usually 10,000 USDT on Bybit testnets).
- Deploy the app in **Real Mode**. Navigate to `TradeSetup`. Verify the real wallet balance appears.
- Verify that switching between Demo and Real (after logout/re-login) correctly updates the displayed balance on the `TradeSetup` screen.

## Success Criteria
- The balance is automatically fetched when the `TradeSetup` screen is opened.
- The balance correctly reflects the connected environment (Demo vs Real).
- Errors (e.g., API timeouts) are surfaced as "Network error" instead of hanging indefinitely.
