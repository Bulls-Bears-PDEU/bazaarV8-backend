import { neon } from "@neondatabase/serverless";
import config from "../config/config.js";

const sql = neon(config.DATABASE_URL);

const initDB = async () => {
	// Create tables if they don't exist
				await sql`
    CREATE TABLE IF NOT EXISTS stocks (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        name VARCHAR(255) NOT NULL,
        volatility NUMERIC(5, 2) NOT NULL,
        sector VARCHAR(100) NOT NULL,
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
    // Add tsvector column for full-text search
																await sql`
    ALTER TABLE stocks
    ADD COLUMN IF NOT EXISTS name_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', name)) STORED
    `;
				// 			await sql`
				// CREATE TABLE IF NOT EXISTS users (
				//     id VARCHAR(255) PRIMARY KEY,
				//     cash_balance NUMERIC(15, 2) NOT NULL DEFAULT 500000 CHECK (cash_balance >= 0),
				//     frozen_balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
				//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				// )`;
				await sql`
    CREATE TABLE IF NOT EXISTS user_stock_transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        volume INTEGER NOT NULL DEFAULT 0,
        price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('buy', 'sell', 'short', 'cover')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
				await sql`
    CREATE TABLE IF NOT EXISTS user_portfolios (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        volume INTEGER NOT NULL DEFAULT 0,
        average_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        UNIQUE (user_id, stock_id)
    )`;
				await sql`				
    CREATE TABLE IF NOT EXISTS stock_ohlc (
        id SERIAL PRIMARY KEY,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        open_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        high_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        low_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        close_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

				// Indexes for faster search and retrieval
				await sql`
    CREATE INDEX IF NOT EXISTS stock_name_fts_idx
        ON STOCKS
        USING GIN (name_tsv)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS user_stock_transactions_user_id_idx ON user_stock_transactions (user_id)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS user_stock_transactions_stock_id_idx ON user_stock_transactions (stock_id)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS user_portfolios_user_id_idx ON user_portfolios (user_id)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS user_portfolios_stock_id_idx ON user_portfolios (stock_id)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS stock_ohlc_stock_id_idx ON stock_ohlc (stock_id)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS stock_ohlc_stock_id_timestamp_idx ON stock_ohlc (stock_id, timestamp DESC)
    `;
};

initDB().catch((err) => {
	console.error("Error initializing database:", err);
	process.exit(1);
});
console.info("Database connection established.");
export default sql;
