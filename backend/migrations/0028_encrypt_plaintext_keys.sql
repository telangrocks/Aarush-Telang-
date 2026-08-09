-- Migration 0028: Clear legacy plaintext exchange_api_key column values
-- All API keys must now be encrypted in exchange_api_key_encrypted/iv/salt.
-- Any existing plaintext keys are set to NULL to complete the security lifecycle.

UPDATE users SET exchange_api_key = NULL WHERE exchange_api_key IS NOT NULL;
