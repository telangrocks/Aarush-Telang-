# 📊 CryptoPulse Database Schema Summary

**System Overview:**  
The **CryptoPulse** database is built on **Cloudflare D1 (SQLite)** and serves as the persistent storage engine for the serverless edge backend and mobile application. It manages user accounts, security controls, exchange API connections, token watchlists, portfolio holdings, automated price alerts, high-frequency trade execution state, and system security audit logs.

---

## 🏗️ Schema Architecture Overview

```
                          ┌───────────────────────┐
                          │         users         │
                          └──────────┬────────────┘
                                     │ (1:N)
        ┌───────────────────┬────────┴────────────┬───────────────────┐
        │                   │                     │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌─────────▼────────┐  ┌───────▼────────┐
│   watchlist    │  │ portfolio_     │  │  price_alerts   │  │ trade_positions│
│                │  │ transactions   │  │                 │  │                │
└────────────────┘  └────────────────┘  └─────────────────┘  └───────┬────────┘
                                                                     │ (1:1)
                                                             ┌───────▼────────┐
                                                             │ trade_execution│
                                                             │ _audit         │
                                                             └────────────────┘
```

---

## 🗂️ Database Tables by Domain

### 1. User Management & Authentication
* **`users`**
  * **Purpose:** Core table storing user accounts, authentication credentials, account lock state, connected exchange configurations (API keys & encrypted secrets), exchange environment (`mainnet`/`testnet`), and regional routing (e.g., Delta India).
  * **Key Fields:** `id` (PK), `email` (Unique), `password_hash`, `status` (`ACTIVE`/`PENDING_VERIFICATION`), `role` (`USER`/`ADMIN`), `exchange_name`, `exchange_api_key`, `exchange_api_secret_encrypted`, `exchange_environment`, `exchange_region`, `failed_login_attempts`, `locked_until`, `created_at`, `updated_at`.

* **`user_security_settings`**
  * **Purpose:** Multi-Factor Authentication (MFA / 2FA) configuration for user accounts, storing TOTP secrets and backup codes.
  * **Key Fields:** `user_id` (PK, FK -> `users.id`), `mfa_enabled`, `mfa_secret`, `mfa_backup_codes`.

* **`user_devices`**
  * **Purpose:** Tracks authorized devices linked to a user's account for security monitoring.
  * **Key Fields:** `id` (PK), `user_id` (FK -> `users.id`), `device_name`, `device_type`, `last_used_at`.

---

### 2. Security, Rate Limiting & Recovery
* **`jwt_blacklist`**
  * **Purpose:** Blacklists revoked JWT access tokens upon user logout to prevent replay attacks.
  * **Key Fields:** `jti` (PK), `user_id`, `expires_at`, `revoked_at`.

* **`refresh_tokens`**
  * **Purpose:** Implements token rotation by tracking valid and revoked refresh tokens for extended user sessions.
  * **Key Fields:** `jti` (PK), `user_id`, `expires_at`, `revoked`, `created_at`.

* **`login_attempts` & `registration_attempts`**
  * **Purpose:** IP-based rate limiting to protect authentication and account creation endpoints from brute-force and credential-stuffing attacks.
  * **Key Fields:** `ip` (PK), `count`, `window_start`.

* **`password_reset_tokens` & `pin_reset_tokens`**
  * **Purpose:** One-time security tokens generated for forgotten password recovery and PIN resets.
  * **Key Fields:** `token`/`id` (PK), `user_id` (FK -> `users.id`), `expires_at`, `used`, `created_at`.

* **`audit_log`**
  * **Purpose:** Centralized security log recording critical actions, IP addresses, user agents, and event metadata.
  * **Key Fields:** `id` (PK), `user_id`, `action`, `ip`, `user_agent`, `metadata`, `created_at`.

---

### 3. Portfolio & Watchlist
* **`watchlist`**
  * **Purpose:** Stores market tokens bookmarked by users for quick tracking.
  * **Key Fields:** `id` (PK), `user_id` (FK -> `users.id`), `token_id`, `added_at`.

* **`portfolio_transactions`**
  * **Purpose:** Tracks asset purchase history, buy prices, and amounts for calculating overall portfolio performance and profit/loss.
  * **Key Fields:** `id` (PK), `user_id` (FK -> `users.id`), `token_id`, `amount`, `buy_price`, `transaction_date`.

---

### 4. Trading Engine & Execution Audit
* **`trade_positions`**
  * **Purpose:** Core engine table for automated trading, managing order life-cycles, entry/exit prices, Stop Loss (SL), Take Profit (TP), Native OCO group tracking, execution latencies, and realized PnL.
  * **Key Fields:** `id` (PK), `user_id` (FK -> `users.id`), `symbol`, `side` (`BUY`/`SELL`), `status` (`OPEN`/`CLOSED`/`CANCELLED`), `order_type`, `entry_price`, `limit_price`, `target_entry_price`, `average_fill_price`, `stop_loss`, `take_profit`, `oco_group_id`, `protection_mode`, `realized_pnl`, `close_reason`, timestamps.

* **`trade_execution_audit`**
  * **Purpose:** Quantitative audit log measuring execution quality, slippage percentages, and latency between trigger signals and exchange fills.
  * **Key Fields:** `id` (PK), `alert_id`, `user_id`, `symbol`, `strategy`, `target_entry_price`, `signal_price`, `execution_price`, `average_fill_price`, `slippage_percent`, `fill_timestamp`.

---

### 6. System Migration Infrastructure
* **`schema_migrations`**
  * **Purpose:** Tracks applied database migrations (`0000` through `0024`) ensuring consistent database schema versioning across dev and production environments.

---

## 🔗 Foreign Keys & Relationships

* **User Data Integrity:**  
  `watchlist`, `portfolio_transactions`, and `price_alerts` maintain a foreign key reference (`FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`). If a user account is removed, all associated watchlist items, transaction histories, and active price alerts are cleanly purged.
* **Security & Device Tracking:**  
  `user_security_settings`, `user_devices`, `password_reset_tokens`, and `pin_reset_tokens` link to `users(id)` to enforce user identity scoping.

---

## ⚙️ Key Constraints & Rules

1. **Email Uniqueness:** `users.email` is declared `UNIQUE` to prevent duplicate account registration.
2. **Alert Conditions:** `price_alerts.condition` is constrained to `('ABOVE', 'BELOW')`.
3. **Trade Directions:** `trade_positions.side` is constrained to `('BUY', 'SELL')`.
4. **Position Status:** `trade_positions.status` is constrained to `('OPEN', 'CLOSED', 'CANCELLED')`.

---

## ⚡ Performance Optimizations

* **Database Indexes:** B-tree indexes are set on high-frequency query paths:
  * `idx_users_email`, `idx_users_status`, `idx_users_role`
  * `idx_watchlist_user_id`
  * `idx_portfolio_transactions_user_id`, `idx_portfolio_transactions_token_id`
  * `idx_price_alerts_user_id`, `idx_price_alerts_is_active`
  * `idx_trade_positions_user_id`, `idx_trade_positions_status`
  * `idx_jwt_blacklist_expires_at`, `idx_refresh_tokens_expires_at`
  * `idx_audit_log_user_id`, `idx_audit_log_action`, `idx_audit_log_created_at`
* **Automated Triggers:** `trigger_users_updated_at` automatically updates `users.updated_at` to the current timestamp whenever a user row is updated.
* **Optimized Database Views:** Pre-compiled SQL views (`v_active_users_with_exchange`, `v_active_price_alerts`, `v_user_portfolio_summary`) streamline complex join operations for backend services.
