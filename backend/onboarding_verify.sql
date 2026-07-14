-- ============================================================================
-- User Onboarding Feature - Schema Verification
-- Run in Cloudflare D1 SQL Console AFTER running onboarding_schema.sql
-- Prints complete schema state for onboarding feature
-- ============================================================================

-- ============================================================================
-- 1. TABLE EXISTENCE
-- ============================================================================
SELECT '=== TABLES ===' AS section;
SELECT name FROM sqlite_master 
WHERE type='table' 
AND name IN ('users', 'registration_attempts', 'schema_migrations')
ORDER BY name;

-- ============================================================================
-- 2. USERS TABLE - Complete column details
-- ============================================================================
SELECT '=== USERS COLUMNS ===' AS section;
PRAGMA table_info(users);

-- ============================================================================
-- 3. REGISTRATION_ATTEMPTS TABLE - Complete column details
-- ============================================================================
SELECT '=== REGISTRATION_ATTEMPTS COLUMNS ===' AS section;
PRAGMA table_info(registration_attempts);

-- ============================================================================
-- 4. INDEXES
-- ============================================================================
SELECT '=== INDEXES ===' AS section;
SELECT name, tbl_name, sql 
FROM sqlite_master 
WHERE type='index' 
AND tbl_name IN ('users', 'registration_attempts')
ORDER BY tbl_name, name;

-- ============================================================================
-- 5. FOREIGN KEYS (users has none, but verify children)
-- ============================================================================
SELECT '=== FOREIGN KEYS ON CHILD TABLES ===' AS section;
SELECT 'watchlist' AS child_table, * FROM pragma_foreign_key_list('watchlist');
SELECT 'portfolio_transactions' AS child_table, * FROM pragma_foreign_key_list('portfolio_transactions');
SELECT 'price_alerts' AS child_table, * FROM pragma_foreign_key_list('price_alerts');

-- ============================================================================
-- 6. TRIGGERS
-- ============================================================================
SELECT '=== TRIGGERS ===' AS section;
SELECT name, tbl_name, sql 
FROM sqlite_master 
WHERE type='trigger' 
AND tbl_name='users';

-- ============================================================================
-- 7. SCHEMA MIGRATIONS TRACKING
-- ============================================================================
SELECT '=== SCHEMA MIGRATIONS ===' AS section;
SELECT * FROM schema_migrations ORDER BY migration_name;

-- ============================================================================
-- 8. CONSTRAINTS CHECK
-- ============================================================================
SELECT '=== USERS CONSTRAINTS ===' AS section;
-- Check email UNIQUE
SELECT sql FROM sqlite_master WHERE type='table' AND name='users';

-- Check CHECK constraint on price_alerts (not onboarding but good to verify)
SELECT sql FROM sqlite_master WHERE type='table' AND name='price_alerts';

-- ============================================================================
-- 9. COMPATIBILITY CHECK - Every column required by onboarding code
-- ============================================================================
SELECT '=== ONBOARDING COLUMN COMPATIBILITY ===' AS section;

-- Required by handleRegister
SELECT 'users.id' AS required_column, CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='id'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END AS status
UNION ALL SELECT 'users.email', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='email'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.password_hash', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='password_hash'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.created_at', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='created_at'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.status', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='status'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.updated_at', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='updated_at'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.failed_login_attempts', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='failed_login_attempts'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.locked_until', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='locked_until'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'users.exchange_name', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='exchange_name'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END

-- registration_attempts columns
UNION ALL SELECT 'registration_attempts.ip', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('registration_attempts') WHERE name='ip'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'registration_attempts.count', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('registration_attempts') WHERE name='count'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END
UNION ALL SELECT 'registration_attempts.window_start', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('registration_attempts') WHERE name='window_start'
) THEN '✅ EXISTS' ELSE '❌ MISSING' END;

-- ============================================================================
-- 10. STALE COLUMNS CHECK (should NOT exist)
-- ============================================================================
SELECT '=== STALE COLUMNS CHECK (should be absent) ===' AS section;
SELECT 'is_verified' AS stale_column, CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='is_verified'
) THEN '❌ STILL EXISTS' ELSE '✅ DROPPED' END AS status
UNION ALL SELECT 'otp_secret', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='otp_secret'
) THEN '❌ STILL EXISTS' ELSE '✅ DROPPED' END
UNION ALL SELECT 'otp_expires_at', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='otp_expires_at'
) THEN '❌ STILL EXISTS' ELSE '✅ DROPPED' END
UNION ALL SELECT 'otp_last_sent_at', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='otp_last_sent_at'
) THEN '❌ STILL EXISTS' ELSE '✅ DROPPED' END
UNION ALL SELECT 'otp_attempt_count', CASE WHEN EXISTS(
  SELECT 1 FROM pragma_table_info('users') WHERE name='otp_attempt_count'
) THEN '❌ STILL EXISTS' ELSE '✅ DROPPED' END;

-- ============================================================================
-- 11. TRIGGER VERIFICATION
-- ============================================================================
SELECT '=== TRIGGER VERIFICATION ===' AS section;
SELECT name, 
  CASE WHEN sql LIKE '%updated_at%' THEN '✅ UPDATES updated_at' ELSE '❌ MISSING LOGIC' END AS logic_check
FROM sqlite_master 
WHERE type='trigger' AND tbl_name='users';

-- ============================================================================
-- 12. FINAL SUMMARY
-- ============================================================================
SELECT '=== SUMMARY ===' AS section;
SELECT 
  (SELECT COUNT(*) FROM pragma_table_info('users')) AS users_columns,
  (SELECT COUNT(*) FROM pragma_table_info('registration_attempts')) AS registration_attempts_columns,
  (SELECT COUNT(*) FROM schema_migrations) AS migrations_tracked,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='users') AS user_indexes,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='users') AS user_triggers;