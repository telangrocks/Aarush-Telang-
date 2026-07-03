-- Migration: create_portfolio_transactions_table
-- Created at: 2026-07-02 17:27:26

CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount REAL NOT NULL,
  buy_price REAL NOT NULL,
  transaction_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);