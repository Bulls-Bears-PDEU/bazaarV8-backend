import { neon } from "@neondatabase/serverless";
import config from "../config/config.js";

const sql = neon(config.DATABASE_URL);

const initDB = async () => {
	await sql`
    CREATE TABLE IF NOT EXISTS STOCKS (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        name VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        ohlc JSONB NOT NULL CHECK (jsonb_typeof(ohlc) = 'array'),
        volume BIGINT NOT NULL,
        drift NUMERIC(5, 2) NOT NULL,
        volatility NUMERIC(5, 2) NOT NULL,
        sector VARCHAR(100) NOT NULL,
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

	await sql`
    CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        balance NUMERIC(15, 2) NOT NULL DEFAULT 10000,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

	await sql`
    CREATE TABLE IF NOT EXISTS user_stocks (
        user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, stock_id)
    )`;

	await sql`
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'stocks'
        ) THEN
            INSERT INTO user_stocks (user_id, stock_id, quantity)
            SELECT
                u.id,
                (stock_entry->>'id')::INTEGER,
                COALESCE((stock_entry->>'quantity')::INTEGER, 0)
            FROM users u,
            LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(u.stocks) = 'array' THEN u.stocks
                    ELSE '[]'::jsonb
                END
            ) AS stock_entry
            WHERE (stock_entry->>'id') IS NOT NULL
            ON CONFLICT (user_id, stock_id)
            DO UPDATE SET quantity = EXCLUDED.quantity;

            ALTER TABLE users DROP COLUMN stocks;
        END IF;
    END
    $$`;

	await sql`
    CREATE INDEX IF NOT EXISTS stock_name_fts_idx
        ON STOCKS
        USING GIN (to_tsvector('english', name))
    `;

	await sql`
    CREATE INDEX IF NOT EXISTS user_stocks_user_id_idx ON user_stocks (user_id)
    `;

	await sql`
    CREATE INDEX IF NOT EXISTS user_stocks_stock_id_idx ON user_stocks (stock_id)
    `;
};

initDB().catch((err) => {
	console.error("Error initializing database:", err);
	process.exit(1);
});
console.info("Database connection established.");
export default sql;
