-- Create Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    hashed_password TEXT NOT NULL,
    status TEXT NOT NULL,
    otp_secret TEXT,
    otp_expires_at INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Create Watchlist table
CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT UNIQUE NOT NULL,
    added_at TEXT NOT NULL
);

-- Create Portfolio table
CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL,
    amount REAL NOT NULL,
    buy_price REAL NOT NULL,
    date TEXT NOT NULL
);

-- Insert seed data for local testing
INSERT OR IGNORE INTO watchlist (token_id, added_at) VALUES ('bitcoin', '2026-06-23T10:00:00.000Z');
INSERT OR IGNORE INTO watchlist (token_id, added_at) VALUES ('ethereum', '2026-06-23T10:05:00.000Z');

INSERT OR IGNORE INTO portfolio (token_id, amount, buy_price, date) VALUES ('bitcoin', 0.05, 64200.00, '2026-06-23T11:00:00.000Z');
INSERT OR IGNORE INTO portfolio (token_id, amount, buy_price, date) VALUES ('solana', 10.0, 130.50, '2026-06-23T11:30:00.000Z');
