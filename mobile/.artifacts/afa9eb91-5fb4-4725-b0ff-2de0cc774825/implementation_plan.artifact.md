# Real-User Testing Plan for Crypto Pulse

This plan outlines a comprehensive end-to-end test of the Crypto Pulse application, simulating a real user's journey from registration to bot activation in both Demo and Real modes.

## User Review Required

> [!IMPORTANT]
> To perform the "Real" bot connection test, I may need a set of valid (restricted) API keys for Bybit if the backend requires actual validation. If you want me to use specific mock keys that the backend accepts as "valid" for testing, please provide them.

> [!NOTE]
> I will assume "Demo" mode can be tested with dummy keys if the backend allows it for the demo environment.

## Open Questions

1.  **Registration Credentials**: Should I create a new account for this test, or is there a preferred test account?
2.  **API Keys**: Are there any "safe" API keys I can use for the "Real" mode test that won't result in actual trades (e.g., using a sub-account with 0 balance)?
3.  **Shortlisting Logic**: Is the "Top 10" logic purely server-side, or should I look for specific client-side calculations?

## Proposed Changes

No source code changes are proposed at this stage. This is a testing and verification task.

### Testing Workflow

#### 1. Discovery & Setup
- Deploy the app to a running device/emulator.
- Monitor logs via Logcat with specific filters for `VM_CHECK`, `MarketCandidatesScreen`, `ExchangeViewModel`, and `BotRepository`.

#### 2. User Authentication
- Navigate to the **Registration/Login** flow.
- Verify validation logic (empty fields, email format, password strength).
- Complete registration and login.

#### 3. Connect Exchange (Demo Mode)
- Navigate to **Connect Exchange**.
- Select **"Demo"** in the `EnvironmentToggle`.
- Input credentials and click "Connect".
- Verify UI feedback (Loading state, Success/Error messages).
- Check backend interaction via logs for the `/api/exchange/connect` call.

#### 4. Market Discovery & Shortlisting
- Navigate to **Market Candidates**.
- Verify the list of coins.
- **Verification Point**: Check if exactly 10 coins are shown or if there's a specific "Top 10" ranking logic visible in the UI/Logs.
- Inspect the `MarketCandidate` data (Rank, Score, Volume, etc.).

#### 5. Demo Bot Activation Flow
- Select a candidate.
- Go through **Trade Setup** -> **Strategy Selection** -> **Risk Management**.
- Click **"Activate Bot"**.
- Verify successful activation and transition to the **Technical Analysis** screen.
- Verify "Mock Alert" functionality (if available in UI).

#### 6. Connect Exchange & Bot (Real Mode)
- Logout and repeat the flow for **"Real"** (Mainnet) mode.
- Verify if the app correctly handles the switch and if the backend distinguishes the environments.

#### 7. Validation & Error Handling
- Test edge cases:
    - Invalid API keys.
    - Network disconnection during candidate fetch.
    - Missing balances.
    - Bot activation failure.

## Verification Plan

### Automated Tests (via ADB)
- `adb shell am start -n com.cryptopulse.app/.MainActivity`
- `adb shell input tap ...` (to navigate and test buttons)
- `take_screenshot` (to document UI states)
- `read_logcat` (to verify API payloads and logic flow)

### Manual Verification
- Visual inspection of screenshots for UI consistency and layout issues.
- Detailed analysis of log sequences to ensure proper state management in ViewModels.
