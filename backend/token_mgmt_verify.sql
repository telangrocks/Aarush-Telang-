-- ============================================================================
-- CryptoPulse Token Management Feature - Complete Schema Verification
-- Run in Cloudflare D1 SQL Console AFTER running token_mgmt_schema.sql
-- Prints complete schema state for Token Management feature
-- ============================================================================

-- ============================================================================
-- 1. TABLE EXISTENCE CHECK
-- ============================================================================
SELECT '=== TABLE EXISTENCE ===' AS section;

SELECT
  name AS table_name,
  CASE
    WHEN name IN ('watchlist', 'portfolio_transactions', 'price_alerts', 'users', 'schema_migrations')
    THEN '✅ REQUIRED'
    ELSE 'ℹ️ OTHER'
  END AS status
FROM sqlite_master
WHERE type = 'table'
AND name IN ('watchlist', 'portfolio_transactions', 'price_alerts', 'users', 'schema_migrations')
ORDER BY name;

-- ============================================================================
-- 2. WATCHLIST TABLE - Complete Schema
-- ============================================================================
SELECT '=== WATCHLIST TABLE ===' AS section;

SELECT '--- Columns ---' AS subsection;
PRAGMA table_info(watchlist);

SELECT '--- Indexes ---' AS subsection;
SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='watchlist';

SELECT '--- Foreign Keys ---' AS subsection;
SELECT * FROM pragma_foreign_key_list('watchlist');

-- ============================================================================
-- 3. PORTFOLIO_TRANSACTIONS TABLE - Complete Schema
-- ============================================================================
SELECT '=== PORTFOLIO_TRANSACTIONS TABLE ===' AS section;

SELECT '--- Columns ---' AS subsection;
PRAGMA table_info(portfolio_transactions);

SELECT '--- Indexes ---' AS subsection;
SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='portfolio_transactions';

SELECT '--- Foreign Keys ---' AS subsection;
SELECT * FROM pragma_foreign_key_list('portfolio_transactions');

-- ============================================================================
-- 4. PRICE_ALERTS TABLE - Complete Schema
-- ============================================================================
SELECT '=== PRICE_ALERTS TABLE ===' AS section;

SELECT '--- Columns ---' AS subsection;
PRAGMA table_info(price_alerts);

SELECT '--- Indexes ---' AS subsection;
SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='price_alerts';

SELECT '--- Foreign Keys ---' AS subsection;
SELECT * FROM pragma_foreign_key_list('price_alerts');

-- Check CHECK constraint
SELECT '--- CHECK Constraints ---' AS subsection;
SELECT sql FROM sqlite_master WHERE type='table' AND name='price_alerts';

-- ============================================================================
-- 5. USERS TABLE - Token Management Related Columns
-- ============================================================================
SELECT '=== USERS TABLE (Token Mgmt Columns) ===' AS section;

SELECT '--- All Columns ---' AS subsection;
PRAGMA table_info(users);

SELECT '--- Indexes ---' AS subsection;
SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='users';

-- ============================================================================
-- 6. VIEWS
-- ============================================================================
SELECT '=== VIEWS ===' AS section;

SELECT name, sql FROM sqlite_master
WHERE type='view'
AND name IN ('v_active_price_alerts', 'v_user_watchlist', 'v_user_portfolio_summary');

-- ============================================================================
-- 8. TRIGGERS
-- ============================================================================
SELECT '=== TRIGGERS ===' AS section;

SELECT name, tbl_name, sql FROM sqlite_master
WHERE type='trigger'
AND tbl_name IN ('users', 'watchlist', 'portfolio_transactions', 'price_alerts');

-- ============================================================================
-- 9. SCHEMA MIGRATIONS TRACKING
-- ============================================================================
SELECT '=== SCHEMA MIGRATIONS ===' AS section;

SELECT * FROM schema_migrations ORDER BY migration_name;

-- ============================================================================
-- 9. COMPATIBILITY MATRIX - Every column/query used by Token Mgmt Code
-- ============================================================================
SELECT '=== COMPATIBILITY MATRIX ===' AS section;

-- Watchlist queries
SELECT 'watchlist.id' AS required_column,
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('watchlist') WHERE name='id') THEN '✅ EXISTS' ELSE '❌ MISSING' END AS status
UNION ALL SELECT 'watchlist.user_id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('watchlist') WHERE name='user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'watchlist.token_id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('watchlist') WHERE name='token_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'watchlist.added_at',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('watchlist') WHERE name='added_at') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Portfolio Transactions
UNION ALL SELECT 'portfolio_transactions.id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('portfolio_transactions') WHERE name='id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'portfolio_transactions.user_id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('portfolio_transactions') WHERE name='user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'portfolio_transactions.token_id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('portfolio_transactions') WHERE name='token_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'portfolio_transactions.amount',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('portfolio_transactions') WHERE name='amount') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'portfolio_transactions.buy_price',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('portfolio_transactions') WHERE name='buy_price') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'portfolio_transactions.transaction_date',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('portfolio_transactions') WHERE name='transaction_date') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Price Alerts
UNION ALL SELECT 'price_alerts.id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.user_id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.token_id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='token_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.target_price',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='target_price') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.condition',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='condition') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.created_at',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='created_at') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.is_active',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='is_active') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'price_alerts.triggered_at',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_table_info('price_alerts') WHERE name='triggered_at') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Foreign Keys
UNION ALL SELECT 'FK: watchlist.user_id -> users.id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_list('watchlist') WHERE "table"='users' AND "from"='user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'FK: portfolio_transactions.user_id -> users.id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_list('portfolio_transactions') WHERE "table"='users' AND "from"='user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'FK: price_alerts.user_id -> users.id',
  CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_list('price_alerts') WHERE "table"='users' AND "from"='user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Indexes
UNION ALL SELECT 'Index: idx_watchlist_user_id',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_watchlist_user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'Index: idx_watchlist_user_token',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_watchlist_user_token') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'Index: idx_portfolio_user_id',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_portfolio_user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'Index: idx_price_alerts_is_active',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_price_alerts_is_active') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'Index: idx_price_alerts_user_id',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_price_alerts_user_id') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Views
UNION ALL SELECT 'View: v_active_price_alerts',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='v_active_price_alerts') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'View: v_user_watchlist',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='v_user_watchlist') THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'View: v_user_portfolio_summary',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='view' AND name='v_user_portfolio_summary') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Trigger
UNION ALL SELECT 'Trigger: trigger_users_updated_at',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trigger_users_updated_at') THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- Migration Tracking
UNION ALL SELECT 'Table: schema_migrations',
  CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations') THEN '✅ EXISTS' ELSE '❌ MISSING' END;

-- ============================================================================
-- 10. FUNCTIONAL QUERY TESTS (EXPLAIN QUERY PLAN)
-- ============================================================================
SELECT '=== FUNCTIONAL QUERY PLANS ===' AS section;

-- Watchlist queries
SELECT 'Watchlist: SELECT by user_id' AS query;
EXPLAIN QUERY PLAN SELECT * FROM watchlist WHERE user_id = 'test' ORDER BY added_at DESC;

SELECT 'Watchlist: INSERT' AS query;
EXPLAIN QUERY PLAN INSERT INTO watchlist (id, user_id, token_id, added_at) VALUES ('1', 'u1', 'btc', datetime('now'));

SELECT 'Watchlist: DELETE by id + user_id' AS query;
EXPLAIN QUERY PLAN DELETE FROM watchlist WHERE id = '1' AND user_id = 'u1';

-- Portfolio queries
SELECT 'Portfolio: SELECT by user_id' AS query;
EXPLAIN QUERY PLAN SELECT * FROM portfolio_transactions WHERE user_id = 'test';

SELECT 'Portfolio: INSERT' AS query;
EXPLAIN QUERY PLAN INSERT INTO portfolio_transactions (id, user_id, token_id, amount, buy_price, transaction_date) VALUES ('1', 'u1', 'btc', 1.0, 50000.0, datetime('now'));

-- Price Alerts queries
SELECT 'Price Alerts: INSERT' AS query;
EXPLAIN QUERY PLAN INSERT INTO price_alerts (id, user_id, token_id, target_price, condition, created_at) VALUES ('1', 'u1', 'btc', 50000, 'ABOVE', datetime('now'));

SELECT 'Price Alerts: Active scan' AS query;
EXPLAIN QUERY PLAN SELECT * FROM price_alerts WHERE is_active = 1;

SELECT 'Price Alerts: Update triggered' AS query;
EXPLAIN QUERY PLAN UPDATE price_alerts SET is_active = 0, triggered_at = datetime('now') WHERE id = '1';

-- ============================================================================
-- 11. FINAL SUMMARY
-- ============================================================================
SELECT '=== FINAL SUMMARY ===' AS section;

SELECT
  (SELECT COUNT(*) FROM pragma_table_info('watchlist')) AS watchlist_columns,
  (SELECT COUNT(*) FROM pragma_table_info('portfolio_transactions')) AS portfolio_columns,
  (SELECT COUNT(*) FROM pragma_table_info('price_alerts')) AS alerts_columns,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name IN ('watchlist', 'portfolio_transactions', 'price_alerts')) AS total_indexes,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='users') AS triggers,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name LIKE 'v_%') AS views,
  (SELECT COUNT(*) FROM schema_migrations) AS migrations_tracked;