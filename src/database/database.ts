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

				await sql`
    CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        title VARCHAR(621) NOT NULL,
        content TEXT NOT NULL,
                is_released BOOLEAN NOT NULL DEFAULT FALSE,
        release_at TIMESTAMP NOT NULL,
        affected_stocks JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

				await sql`
        CREATE TABLE IF NOT EXISTS ipo (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            symbol VARCHAR(20) NOT NULL,
            close_date TIMESTAMP NOT NULL,
            open_date TIMESTAMP NOT NULL,
            allotment_date TIMESTAMP NOT NULL,
            subscription_rate NUMERIC(10, 2) NOT NULL DEFAULT 0,
            sector VARCHAR(100) NOT NULL,
            is_open_to_subscription BOOLEAN NOT NULL DEFAULT FALSE,
            lot_size INTEGER NOT NULL,
            max_price NUMERIC(15, 2) NOT NULL,
            min_price NUMERIC(15, 2) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'dormant' CHECK (status IN ('dormant', 'upcoming', 'open', 'closed', 'listed', 'withdrawn')),
            shares_offered BIGINT NOT NULL,
            listing_price NUMERIC(15, 2) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`;

			await sql`
          ALTER TABLE ipo
          DROP COLUMN IF EXISTS issue_type
          `;

				await sql`
          ALTER TABLE ipo
          ALTER COLUMN close_date TYPE TIMESTAMP
          `;

				await sql`
          ALTER TABLE ipo
          ALTER COLUMN open_date TYPE TIMESTAMP
          `;

				await sql`
          ALTER TABLE ipo
          ALTER COLUMN allotment_date TYPE TIMESTAMP
          `;

				await sql`
          ALTER TABLE ipo
          ALTER COLUMN status SET DEFAULT 'dormant'
          `;

				await sql`
          ALTER TABLE ipo
          DROP CONSTRAINT IF EXISTS ipo_status_check
          `;

				await sql`
          ALTER TABLE ipo
          ADD CONSTRAINT ipo_status_check CHECK (status IN ('dormant', 'upcoming', 'open', 'closed', 'listed', 'withdrawn'))
          `;

				await sql`
        ALTER TABLE news
        ADD COLUMN IF NOT EXISTS is_released BOOLEAN NOT NULL DEFAULT FALSE
        `;

				// Single-row table (id = 1) holding the global market state used by
				// the stock engine: pause switch and sentiment driving the drift.
				await sql`
        CREATE TABLE IF NOT EXISTS market (
            id INTEGER PRIMARY KEY DEFAULT 1,
            is_paused BOOLEAN NOT NULL DEFAULT FALSE,
            sentiment VARCHAR(10) NOT NULL DEFAULT 'neutral' CHECK (sentiment IN ('bullish', 'bearish', 'neutral')),
            paused_at TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT market_singleton CHECK (id = 1)
        )`;

				await sql`
        INSERT INTO market (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING
        `;

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
				await sql`
    CREATE INDEX IF NOT EXISTS news_release_at_idx ON news (release_at DESC)
    `;
				await sql`
    CREATE INDEX IF NOT EXISTS news_affected_stocks_idx ON news USING GIN (affected_stocks)
    `;
				await sql`
        CREATE INDEX IF NOT EXISTS ipo_open_date_idx ON ipo (open_date DESC)
        `;
				await sql`
        CREATE INDEX IF NOT EXISTS ipo_status_idx ON ipo (status)
        `;
				await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS ipo_symbol_idx ON ipo (symbol)
        `;
};

initDB().catch((err) => {
	console.error("Error initializing database:", err);
	process.exit(1);
});
console.info("Database connection established.");
export default sql;
