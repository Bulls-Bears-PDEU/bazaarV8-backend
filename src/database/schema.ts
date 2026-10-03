import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sql from "./database.js";

/**
 * This file's own source, hashed. Any edit to a migration changes it, so the
 * schema is re-applied exactly when there is something new to apply.
 */
const schemaVersion = () =>
	createHash("sha256")
		.update(readFileSync(fileURLToPath(import.meta.url)))
		.digest("hex");

const appliedSchemaVersion = async () => {
	try {
		const rows = await sql`SELECT version FROM schema_meta WHERE id = 1`;
		return rows[0] ? String(rows[0].version) : null;
	} catch (error) {
		// 42P01: the table does not exist yet, on a fresh database.
		if ((error as { code?: string })?.code === "42P01") return null;
		throw error;
	}
};

/**
 * Applies the schema below, unless this exact version of it already ran.
 *
 * The database is a long way off (each statement is a few hundred ms) and
 * there are over a hundred statements, so applying them every boot kept the
 * server, and everything waiting on it like scheduled news, down for a minute
 * or more after each restart. Delete the schema_meta row to force a re-run.
 */
export const initDB = async () => {
	const version = schemaVersion();
	if ((await appliedSchemaVersion()) === version) return;

	const started = Date.now();
	await applySchema();
	await sql`
    CREATE TABLE IF NOT EXISTS schema_meta (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        version TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
	await sql`
    INSERT INTO schema_meta (id, version) VALUES (1, ${version})
    ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, applied_at = NOW()
    `;
	console.info(`Schema applied in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
};

/**
 * Creates and migrates every table the app owns. Better Auth owns `users`,
 * `session`, `account` and `verification`, so those must already exist (run
 * the Better Auth migration first on a fresh database).
 *
 * Awaited by server.ts before the HTTP server listens and before the stock
 * engine starts, so nothing can query a table that is not there yet.
 * Every statement is idempotent: this re-runs whenever this file changes.
 */
const applySchema = async () => {
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
	// Optional company logo; players see a monogram when it is unset.
	await sql`ALTER TABLE stocks ADD COLUMN IF NOT EXISTS logo_url TEXT`;
	// Uploaded logos, stored the way avatars are so both apps -- on different
	// origins -- load them from the backend. Always a re-encoded 256px WebP, so
	// a row is a few kilobytes however large the upload was.
	await sql`
    CREATE TABLE IF NOT EXISTS stock_logos (
        stock_id INTEGER PRIMARY KEY REFERENCES stocks(id) ON DELETE CASCADE,
        content_type VARCHAR(20) NOT NULL,
        data BYTEA NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
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

	await sql`ALTER TABLE ipo DROP COLUMN IF EXISTS issue_type`;
	await sql`ALTER TABLE ipo ALTER COLUMN close_date TYPE TIMESTAMP`;
	await sql`ALTER TABLE ipo ALTER COLUMN open_date TYPE TIMESTAMP`;
	await sql`ALTER TABLE ipo ALTER COLUMN allotment_date TYPE TIMESTAMP`;
	await sql`ALTER TABLE ipo ALTER COLUMN status SET DEFAULT 'dormant'`;
	await sql`ALTER TABLE ipo DROP CONSTRAINT IF EXISTS ipo_status_check`;
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

	await migrateMoneyColumns();
	await migrateLivePrice();
	await migrateStartingPrice();
	await migrateTrading();
	await migrateWatchlistsAndAlerts();
	await migrateIpoApplications();
	await migrateNewsImpacts();
	await migrateUserProfiles();

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
	// addStock and IPO listing both resolve a stock by symbol, so duplicates
	// would silently pick an arbitrary row.
	await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS stocks_symbol_idx ON stocks (symbol)
    `;
};

/**
 * Better Auth maps an additionalFields entry of type "number" to INTEGER, so
 * cash_balance and frozen_balance were created as whole rupees. Every trade
 * would round to the rupee and the frozen-balance reconciliation could never
 * balance. Widen them to the NUMERIC(15,2) the original schema intended.
 *
 * Guarded on the current type so the table is only rewritten once. Note that
 * Better Auth's CLI migration only adds missing columns; it will not narrow
 * these back.
 */
const migrateMoneyColumns = async () => {
	await sql`
    DO $$
    BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'users'
              AND column_name = 'cash_balance') <> 'numeric' THEN
            ALTER TABLE users
            ALTER COLUMN cash_balance TYPE NUMERIC(15, 2) USING cash_balance::numeric;
        END IF;
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'users'
              AND column_name = 'frozen_balance') <> 'numeric' THEN
            ALTER TABLE users
            ALTER COLUMN frozen_balance TYPE NUMERIC(15, 2) USING COALESCE(frozen_balance, 0)::numeric;
        END IF;
    END $$
    `;
	await sql`ALTER TABLE users ALTER COLUMN cash_balance SET DEFAULT 500000`;
	await sql`ALTER TABLE users ALTER COLUMN frozen_balance SET DEFAULT 0`;

	// NOT VALID: enforced for every new write, but a pre-existing bad row can
	// never stop the server from booting.
	await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cash_balance_nonneg`;
	await sql`
    ALTER TABLE users
    ADD CONSTRAINT users_cash_balance_nonneg CHECK (cash_balance >= 0) NOT VALID
    `;
	await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_frozen_balance_nonneg`;
	await sql`
    ALTER TABLE users
    ADD CONSTRAINT users_frozen_balance_nonneg CHECK (frozen_balance >= 0) NOT VALID
    `;
};

/**
 * Orders, positions and the settlement function.
 *
 * Position model: one user_portfolios row per (user, stock) with a signed
 * volume. Positive is long, negative is short, and average_price is always the
 * positive entry price. The client only ever sends "buy" or "sell"; whether that
 * buys, covers, sells or shorts is derived from the position, and a single
 * order may do two of them (sell 80 while holding 50 sells 50, shorts 30).
 *
 * Shorts lock short_margin_pct of the notional from cash into frozen_balance
 * and user_portfolios.margin_locked. Short proceeds are not credited; P&L is
 * settled into cash on cover. Net worth is therefore
 *   cash + frozen + sum(long volume * price) + sum((entry - price) * short qty)
 */
const migrateTrading = async () => {
	// Trading rules live on the market singleton, which is already cached in
	// memory and read every tick, so checking them costs nothing.
	await sql`ALTER TABLE market ADD COLUMN IF NOT EXISTS short_margin_pct NUMERIC(5, 2) NOT NULL DEFAULT 50.00`;
	await sql`ALTER TABLE market ADD COLUMN IF NOT EXISTS allow_short_selling BOOLEAN NOT NULL DEFAULT TRUE`;
	await sql`ALTER TABLE market ADD COLUMN IF NOT EXISTS allow_limit_orders BOOLEAN NOT NULL DEFAULT TRUE`;
	await sql`ALTER TABLE market ADD COLUMN IF NOT EXISTS max_order_quantity INTEGER NOT NULL DEFAULT 100000`;

	await sql`
    CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type VARCHAR(6) NOT NULL CHECK (order_type IN ('market', 'limit')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        filled_quantity INTEGER NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
        limit_price NUMERIC(15, 2),
        average_fill_price NUMERIC(15, 2),
        -- Cash and short margin held in frozen_balance while a limit order rests.
        reserved_cash NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (reserved_cash >= 0),
        reserved_margin NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (reserved_margin >= 0),
        status VARCHAR(10) NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
        reject_reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        filled_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        CONSTRAINT orders_limit_price_required
            CHECK (order_type <> 'limit' OR (limit_price IS NOT NULL AND limit_price > 0)),
        CONSTRAINT orders_fill_within_quantity CHECK (filled_quantity <= quantity)
    )`;
	await sql`CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC)`;
	// What the player asked for: buy (open or add to a long), sell (close a long),
	// short (open or add to a short) or cover (close a short). side is derived
	// from it for the matcher. Orders placed before actions existed have none and
	// keep the old behaviour, where the position decided.
	await sql`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS action VARCHAR(5)
        CHECK (action IN ('buy', 'sell', 'short', 'cover'))
    `;
	// The matcher's boot load; partial so it stays tiny whatever the history size.
	await sql`
    CREATE INDEX IF NOT EXISTS orders_pending_by_stock_idx
        ON orders (stock_id, side, limit_price) WHERE status = 'pending'
    `;

	await sql`ALTER TABLE user_portfolios ADD COLUMN IF NOT EXISTS margin_locked NUMERIC(15, 2) NOT NULL DEFAULT 0`;
	await sql`ALTER TABLE user_portfolios ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`;
	await sql`ALTER TABLE user_portfolios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`;
	await sql`ALTER TABLE user_portfolios DROP CONSTRAINT IF EXISTS user_portfolios_margin_only_short`;
	await sql`
    ALTER TABLE user_portfolios
    ADD CONSTRAINT user_portfolios_margin_only_short CHECK (volume < 0 OR margin_locked = 0) NOT VALID
    `;

	// Ledger volume is always positive; the direction is transaction_type. The
	// market overview's buy/sell split already relies on that.
	await sql`
    ALTER TABLE user_stock_transactions
    ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL
    `;
	await sql`ALTER TABLE user_stock_transactions ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(15, 2) NOT NULL DEFAULT 0`;
	await sql`ALTER TABLE user_stock_transactions DROP CONSTRAINT IF EXISTS ust_volume_positive`;
	await sql`
    ALTER TABLE user_stock_transactions
    ADD CONSTRAINT ust_volume_positive CHECK (volume > 0) NOT VALID
    `;
	await sql`
    CREATE INDEX IF NOT EXISTS ust_user_ts_idx ON user_stock_transactions (user_id, timestamp DESC)
    `;

	// One row per closed slice, including partial closes, so realized P&L per
	// position is just rows and total realized is a SUM.
	await sql`
    CREATE TABLE IF NOT EXISTS closed_positions (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        side VARCHAR(5) NOT NULL CHECK (side IN ('long', 'short')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        entry_price NUMERIC(15, 2) NOT NULL,
        exit_price NUMERIC(15, 2) NOT NULL,
        realized_pnl NUMERIC(15, 2) NOT NULL,
        opened_at TIMESTAMP,
        closed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closing_transaction_id INTEGER REFERENCES user_stock_transactions(id) ON DELETE SET NULL
    )`;
	await sql`
    CREATE INDEX IF NOT EXISTS closed_positions_user_idx ON closed_positions (user_id, closed_at DESC)
    `;

	await createSettlementFunctions();
};

/**
 * Settlement runs inside Postgres so a fill is one atomic round trip. The neon
 * HTTP driver cannot read-then-write in a transaction, and a pg transaction
 * would cost several round trips to Neon per order.
 *
 * Lock order is always orders -> users -> user_portfolios. Every path that
 * touches money (market fill, limit fill, cancel) must follow it, or two of
 * them can deadlock. Locking the users row serialises all of one user's fills,
 * so a balance can never be spent twice.
 *
 * Row locks must be FOR NO KEY UPDATE, never FOR UPDATE. Inserting an order
 * takes a KEY SHARE lock on the user row through its foreign key, and FOR
 * UPDATE conflicts with KEY SHARE: two concurrent orders each held one and
 * waited on the other (reproduced as 40P01 deadlocks in pnpm smoke:trading).
 * FOR NO KEY UPDATE still serialises writers but does not conflict with
 * KEY SHARE.
 *
 * Errors are raised with the error code as the message and a human-readable
 * DETAIL; src/trading/errors.ts maps them to HTTP responses.
 */
const createSettlementFunctions = async () => {
	// An order's action must fit the position it trades against: no order ever
	// closes one position and opens the opposite one. Used when an order fills.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_check_action(
        p_action TEXT, p_quantity INTEGER, p_volume INTEGER, p_allow_short BOOLEAN)
    RETURNS VOID
    LANGUAGE plpgsql
    AS $$
    BEGIN
        IF p_action IS NULL THEN
            RETURN;
        END IF;
        IF p_action = 'buy' AND p_volume < 0 THEN
            RAISE EXCEPTION USING MESSAGE = 'POSITION_CONFLICT',
                DETAIL = format('You are short %s shares. Cover them before buying.', -p_volume);
        ELSIF p_action = 'short' AND p_volume > 0 THEN
            RAISE EXCEPTION USING MESSAGE = 'POSITION_CONFLICT',
                DETAIL = format('You hold %s shares. Sell them before shorting.', p_volume);
        ELSIF p_action = 'short' AND NOT p_allow_short THEN
            RAISE EXCEPTION USING MESSAGE = 'SHORTING_DISABLED', DETAIL = 'Short selling is turned off.';
        ELSIF p_action = 'sell' AND p_volume <= 0 THEN
            RAISE EXCEPTION USING MESSAGE = 'NO_POSITION', DETAIL = CASE WHEN p_volume < 0
                THEN 'You are short this stock. Use Cover to close a short.'
                ELSE 'You hold no shares of this stock to sell.' END;
        ELSIF p_action = 'sell' AND p_quantity > p_volume THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                DETAIL = format('You can sell at most %s shares.', p_volume);
        ELSIF p_action = 'cover' AND p_volume >= 0 THEN
            RAISE EXCEPTION USING MESSAGE = 'NO_POSITION', DETAIL = CASE WHEN p_volume > 0
                THEN 'You hold this stock. Use Sell to close a long.'
                ELSE 'You have no short in this stock to cover.' END;
        ELSIF p_action = 'cover' AND p_quantity > -p_volume THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                DETAIL = format('You can cover at most %s shares.', -p_volume);
        END IF;
    END
    $$
    `;

	// The same check when an order is placed or modified, where shares already
	// promised to the player's other open sell or cover orders are not available
	// again, so two resting orders can never close the same shares.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_validate_action(
        p_user_id TEXT, p_stock_id INTEGER, p_action TEXT, p_quantity INTEGER, p_exclude_order BIGINT)
    RETURNS VOID
    LANGUAGE plpgsql
    AS $$
    DECLARE
        v_vol INTEGER;
        v_allow_short BOOLEAN;
        v_committed INTEGER;
    BEGIN
        IF p_action IS NULL OR p_action NOT IN ('buy', 'sell', 'short', 'cover') THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_ORDER',
                DETAIL = 'Choose Buy, Sell, Short or Cover.';
        END IF;
        SELECT allow_short_selling INTO v_allow_short FROM market WHERE id = 1;
        SELECT COALESCE((SELECT volume FROM user_portfolios
            WHERE user_id = p_user_id AND stock_id = p_stock_id), 0) INTO v_vol;
        PERFORM bazaar_check_action(p_action, p_quantity, v_vol, v_allow_short);

        IF p_action IN ('sell', 'cover') THEN
            SELECT COALESCE(SUM(quantity - filled_quantity), 0)::int INTO v_committed
            FROM orders
            WHERE user_id = p_user_id AND stock_id = p_stock_id AND status = 'pending'
                AND action = p_action AND id IS DISTINCT FROM p_exclude_order;
            IF v_committed > 0 AND p_quantity + v_committed > abs(v_vol) THEN
                RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                    DETAIL = format('You can %s at most %s more shares: %s are already in open orders.',
                        p_action, GREATEST(abs(v_vol) - v_committed, 0), v_committed);
            END IF;
        END IF;
    END
    $$
    `;

	await sql`
    CREATE OR REPLACE FUNCTION bazaar_execute_fill(p_order_id BIGINT, p_price NUMERIC)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        o orders%ROWTYPE;
        m market%ROWTYPE;
        v_price NUMERIC(15, 2) := round(p_price, 2);
        v_locked BOOLEAN;
        v_cash NUMERIC(15, 2);
        v_frozen NUMERIC(15, 2);
        v_vol INTEGER;
        v_avg NUMERIC(15, 2);
        v_margin NUMERIC(15, 2);
        v_opened TIMESTAMP;
        v_close_qty INTEGER;
        v_open_qty INTEGER;
        v_amount NUMERIC(15, 2);
        v_released NUMERIC(15, 2);
        v_pnl NUMERIC(15, 2);
        v_total_pnl NUMERIC(15, 2) := 0;
        v_new_vol INTEGER;
        v_new_avg NUMERIC(15, 2);
        v_txn_id INTEGER;
        v_fills JSONB := '[]'::jsonb;
        v_opens_short BOOLEAN := FALSE;
    BEGIN
        IF v_price IS NULL OR v_price <= 0 THEN
            RAISE EXCEPTION USING MESSAGE = 'NO_PRICE', DETAIL = 'There is no price to fill this order at yet.';
        END IF;

        SELECT * INTO o FROM orders WHERE id = p_order_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ORDER_NOT_FOUND', DETAIL = 'Order not found.';
        END IF;
        IF o.status <> 'pending' THEN
            RAISE EXCEPTION USING MESSAGE = 'ORDER_NOT_PENDING', DETAIL = format('Order is already %s.', o.status);
        END IF;

        SELECT * INTO m FROM market WHERE id = 1;
        IF m.is_paused THEN
            RAISE EXCEPTION USING MESSAGE = 'MARKET_PAUSED', DETAIL = 'The market is paused.';
        END IF;

        SELECT locked INTO v_locked FROM stocks WHERE id = o.stock_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'STOCK_NOT_FOUND', DETAIL = 'Stock not found.';
        END IF;
        IF v_locked THEN
            RAISE EXCEPTION USING MESSAGE = 'STOCK_LOCKED', DETAIL = 'Trading in this stock is halted.';
        END IF;

        SELECT cash_balance, frozen_balance INTO v_cash, v_frozen
        FROM users WHERE id = o.user_id FOR NO KEY UPDATE;

        -- Whatever the order reserved while it rested is released before settling.
        v_cash := v_cash + o.reserved_cash + o.reserved_margin;
        v_frozen := v_frozen - o.reserved_cash - o.reserved_margin;

        SELECT volume, average_price, margin_locked, opened_at
        INTO v_vol, v_avg, v_margin, v_opened
        FROM user_portfolios
        WHERE user_id = o.user_id AND stock_id = o.stock_id
        FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            v_vol := 0; v_avg := 0; v_margin := 0; v_opened := NULL;
        END IF;

        -- The position may have changed since a resting order was placed.
        PERFORM bazaar_check_action(o.action, o.quantity, v_vol, m.allow_short_selling);

        IF o.side = 'buy' THEN
            -- Covers any short first, then buys the remainder as a long.
            v_close_qty := LEAST(o.quantity, GREATEST(-v_vol, 0));
            v_open_qty := o.quantity - v_close_qty;

            IF v_close_qty > 0 THEN
                v_released := round(v_margin * v_close_qty / (-v_vol), 2);
                v_pnl := round((v_avg - v_price) * v_close_qty, 2);
                v_cash := v_cash + v_released + v_pnl;
                v_frozen := v_frozen - v_released;
                v_margin := v_margin - v_released;
                v_total_pnl := v_total_pnl + v_pnl;
                INSERT INTO user_stock_transactions (user_id, stock_id, volume, price, transaction_type, order_id, realized_pnl)
                VALUES (o.user_id, o.stock_id, v_close_qty, v_price, 'cover', o.id, v_pnl)
                RETURNING id INTO v_txn_id;
                INSERT INTO closed_positions (user_id, stock_id, side, quantity, entry_price, exit_price, realized_pnl, opened_at, closing_transaction_id)
                VALUES (o.user_id, o.stock_id, 'short', v_close_qty, v_avg, v_price, v_pnl, v_opened, v_txn_id);
                v_fills := v_fills || jsonb_build_object(
                    'transaction_type', 'cover', 'quantity', v_close_qty, 'price', v_price, 'realized_pnl', v_pnl);
            END IF;

            IF v_open_qty > 0 THEN
                v_amount := round(v_open_qty * v_price, 2);
                v_cash := v_cash - v_amount;
                INSERT INTO user_stock_transactions (user_id, stock_id, volume, price, transaction_type, order_id, realized_pnl)
                VALUES (o.user_id, o.stock_id, v_open_qty, v_price, 'buy', o.id, 0);
                v_fills := v_fills || jsonb_build_object(
                    'transaction_type', 'buy', 'quantity', v_open_qty, 'price', v_price, 'realized_pnl', 0);
            END IF;

            v_new_vol := v_vol + o.quantity;
            v_new_avg := CASE
                WHEN v_vol >= 0 THEN round((v_avg * v_vol + v_price * o.quantity) / v_new_vol, 2)
                WHEN v_new_vol < 0 THEN v_avg          -- partial cover: entry unchanged
                WHEN v_new_vol = 0 THEN 0
                ELSE v_price                           -- flipped to long: fresh entry
            END;
        ELSE
            -- Sells any long first, then shorts the remainder.
            v_close_qty := LEAST(o.quantity, GREATEST(v_vol, 0));
            v_open_qty := o.quantity - v_close_qty;

            IF v_close_qty > 0 THEN
                v_amount := round(v_close_qty * v_price, 2);
                v_pnl := round((v_price - v_avg) * v_close_qty, 2);
                v_cash := v_cash + v_amount;
                v_total_pnl := v_total_pnl + v_pnl;
                INSERT INTO user_stock_transactions (user_id, stock_id, volume, price, transaction_type, order_id, realized_pnl)
                VALUES (o.user_id, o.stock_id, v_close_qty, v_price, 'sell', o.id, v_pnl)
                RETURNING id INTO v_txn_id;
                INSERT INTO closed_positions (user_id, stock_id, side, quantity, entry_price, exit_price, realized_pnl, opened_at, closing_transaction_id)
                VALUES (o.user_id, o.stock_id, 'long', v_close_qty, v_avg, v_price, v_pnl, v_opened, v_txn_id);
                v_fills := v_fills || jsonb_build_object(
                    'transaction_type', 'sell', 'quantity', v_close_qty, 'price', v_price, 'realized_pnl', v_pnl);
            END IF;

            IF v_open_qty > 0 THEN
                IF NOT m.allow_short_selling THEN
                    RAISE EXCEPTION USING MESSAGE = 'SHORTING_DISABLED',
                        DETAIL = format('Short selling is disabled. You can sell at most %s shares.', GREATEST(v_vol, 0));
                END IF;
                v_opens_short := TRUE;
                v_amount := round(v_open_qty * v_price * m.short_margin_pct / 100, 2);
                v_cash := v_cash - v_amount;
                v_frozen := v_frozen + v_amount;
                v_margin := v_margin + v_amount;
                INSERT INTO user_stock_transactions (user_id, stock_id, volume, price, transaction_type, order_id, realized_pnl)
                VALUES (o.user_id, o.stock_id, v_open_qty, v_price, 'short', o.id, 0);
                v_fills := v_fills || jsonb_build_object(
                    'transaction_type', 'short', 'quantity', v_open_qty, 'price', v_price, 'realized_pnl', 0,
                    'margin_locked', v_amount);
            END IF;

            v_new_vol := v_vol - o.quantity;
            v_new_avg := CASE
                WHEN v_vol <= 0 THEN round((v_avg * (-v_vol) + v_price * o.quantity) / (-v_new_vol), 2)
                WHEN v_new_vol > 0 THEN v_avg          -- partial sell: cost unchanged
                WHEN v_new_vol = 0 THEN 0
                ELSE v_price                           -- flipped to short: fresh entry
            END;
        END IF;

        -- A cover that loses more than its margin is paid from cash, so it can
        -- be refused too: there is no forced liquidation, the player must free
        -- cash first.
        IF v_cash < 0 THEN
            RAISE EXCEPTION USING
                MESSAGE = CASE WHEN v_opens_short THEN 'INSUFFICIENT_MARGIN' ELSE 'INSUFFICIENT_FUNDS' END,
                DETAIL = format('This order needs %s more than your available cash.', to_char(-v_cash, 'FM999999999990.00'));
        END IF;

        -- No short left means no margin; drop any rounding dust.
        IF v_new_vol >= 0 THEN
            v_frozen := v_frozen - v_margin;
            v_cash := v_cash + v_margin;
            v_margin := 0;
        END IF;

        UPDATE users SET cash_balance = v_cash, frozen_balance = v_frozen WHERE id = o.user_id;

        IF v_new_vol = 0 THEN
            DELETE FROM user_portfolios WHERE user_id = o.user_id AND stock_id = o.stock_id;
        ELSE
            INSERT INTO user_portfolios (user_id, stock_id, volume, average_price, margin_locked, opened_at, updated_at)
            VALUES (o.user_id, o.stock_id, v_new_vol, v_new_avg, v_margin, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, stock_id) DO UPDATE SET
                volume = EXCLUDED.volume,
                average_price = EXCLUDED.average_price,
                margin_locked = EXCLUDED.margin_locked,
                updated_at = CURRENT_TIMESTAMP,
                opened_at = CASE
                    WHEN sign(user_portfolios.volume) <> sign(EXCLUDED.volume) THEN CURRENT_TIMESTAMP
                    ELSE user_portfolios.opened_at
                END;
        END IF;

        UPDATE orders
        SET status = 'filled',
            filled_quantity = quantity,
            average_fill_price = v_price,
            reserved_cash = 0,
            reserved_margin = 0,
            filled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = o.id;

        RETURN jsonb_build_object(
            'status', 'filled',
            'order_id', o.id,
            'user_id', o.user_id,
            'stock_id', o.stock_id,
            'side', o.side,
            'action', o.action,
            'order_type', o.order_type,
            'quantity', o.quantity,
            'price', v_price,
            'fills', v_fills,
            'realized_pnl', v_total_pnl,
            'position', jsonb_build_object(
                'stock_id', o.stock_id,
                'volume', v_new_vol,
                'average_price', v_new_avg,
                'margin_locked', v_margin),
            'cash_balance', v_cash,
            'frozen_balance', v_frozen
        );
    END
    $$
    `;

	// The action parameter changed the signature; drop the old one so a call
	// can never resolve to it.
	await sql`DROP FUNCTION IF EXISTS bazaar_place_market_order(TEXT, INTEGER, TEXT, INTEGER, NUMERIC)`;
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_place_market_order(
        p_user_id TEXT, p_stock_id INTEGER, p_side TEXT, p_quantity INTEGER, p_price NUMERIC,
        p_action TEXT DEFAULT NULL)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        v_max INTEGER;
        v_order_id BIGINT;
    BEGIN
        SELECT max_order_quantity INTO v_max FROM market WHERE id = 1;
        IF p_quantity > v_max THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                DETAIL = format('Orders are limited to %s shares.', v_max);
        END IF;

        IF p_action IS NOT NULL THEN
            PERFORM bazaar_validate_action(p_user_id, p_stock_id, p_action, p_quantity, NULL);
        END IF;

        INSERT INTO orders (user_id, stock_id, side, order_type, quantity, action)
        VALUES (p_user_id, p_stock_id, p_side, 'market', p_quantity, p_action)
        RETURNING id INTO v_order_id;

        RETURN bazaar_execute_fill(v_order_id, p_price);
    END
    $$
    `;

	await createLimitOrderFunctions();
};

/**
 * Limit orders reserve what their fill would need in frozen_balance while they
 * rest, so a player cannot spend the same cash twice. bazaar_execute_fill
 * releases the reservation before settling, so the actual cost can differ
 * from the reservation without leaving anything behind.
 */
const createLimitOrderFunctions = async () => {
	// What a limit order must reserve, given the position right now:
	//  - buying a long: the full cost at the limit price
	//  - covering a short: only a loss beyond the margin the cover releases,
	//    otherwise a player could not place a limit order to exit their short
	//  - selling a long: nothing
	//  - opening a short: the short margin at the limit price
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_limit_reservation(
        p_user_id TEXT, p_stock_id INTEGER, p_side TEXT, p_quantity INTEGER, p_limit NUMERIC,
        OUT reserved_cash NUMERIC, OUT reserved_margin NUMERIC)
    LANGUAGE plpgsql
    AS $$
    DECLARE
        v_vol INTEGER := 0;
        v_avg NUMERIC(15, 2) := 0;
        v_margin NUMERIC(15, 2) := 0;
        v_close INTEGER;
        v_open INTEGER;
        m market%ROWTYPE;
    BEGIN
        reserved_cash := 0;
        reserved_margin := 0;

        SELECT volume, average_price, margin_locked INTO v_vol, v_avg, v_margin
        FROM user_portfolios WHERE user_id = p_user_id AND stock_id = p_stock_id;
        IF NOT FOUND THEN
            v_vol := 0; v_avg := 0; v_margin := 0;
        END IF;

        IF p_side = 'buy' THEN
            v_close := LEAST(p_quantity, GREATEST(-v_vol, 0));
            v_open := p_quantity - v_close;
            reserved_cash := round(v_open * p_limit, 2);
            IF v_close > 0 THEN
                reserved_cash := reserved_cash + round(GREATEST(
                    (p_limit - v_avg) * v_close - v_margin * v_close / (-v_vol), 0), 2);
            END IF;
        ELSE
            v_open := p_quantity - LEAST(p_quantity, GREATEST(v_vol, 0));
            IF v_open > 0 THEN
                SELECT * INTO m FROM market WHERE id = 1;
                IF NOT m.allow_short_selling THEN
                    RAISE EXCEPTION USING MESSAGE = 'SHORTING_DISABLED',
                        DETAIL = format('Short selling is disabled. You can sell at most %s shares.', GREATEST(v_vol, 0));
                END IF;
                reserved_margin := round(v_open * p_limit * m.short_margin_pct / 100, 2);
            END IF;
        END IF;
    END
    $$
    `;

	// Places a limit order. If it is marketable on arrival (a buy at or above
	// the price, a sell at or below it) it fills straight away at the current
	// price, which is at least as good as the limit.
	await sql`DROP FUNCTION IF EXISTS bazaar_place_limit_order(TEXT, INTEGER, TEXT, INTEGER, NUMERIC, NUMERIC)`;
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_place_limit_order(
        p_user_id TEXT, p_stock_id INTEGER, p_side TEXT, p_quantity INTEGER,
        p_limit NUMERIC, p_price NUMERIC, p_action TEXT DEFAULT NULL)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        m market%ROWTYPE;
        v_locked BOOLEAN;
        v_cash NUMERIC(15, 2);
        v_frozen NUMERIC(15, 2);
        v_limit NUMERIC(15, 2) := round(p_limit, 2);
        v_res RECORD;
        v_total NUMERIC(15, 2);
        v_order_id BIGINT;
    BEGIN
        SELECT * INTO m FROM market WHERE id = 1;
        IF m.is_paused THEN
            RAISE EXCEPTION USING MESSAGE = 'MARKET_PAUSED', DETAIL = 'The market is paused.';
        END IF;
        IF NOT m.allow_limit_orders THEN
            RAISE EXCEPTION USING MESSAGE = 'LIMIT_ORDERS_DISABLED', DETAIL = 'Limit orders are disabled.';
        END IF;
        IF p_quantity > m.max_order_quantity THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                DETAIL = format('Orders are limited to %s shares.', m.max_order_quantity);
        END IF;

        SELECT locked INTO v_locked FROM stocks WHERE id = p_stock_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'STOCK_NOT_FOUND', DETAIL = 'Stock not found.';
        END IF;
        IF v_locked THEN
            RAISE EXCEPTION USING MESSAGE = 'STOCK_LOCKED', DETAIL = 'Trading in this stock is halted.';
        END IF;

        SELECT cash_balance, frozen_balance INTO v_cash, v_frozen
        FROM users WHERE id = p_user_id FOR NO KEY UPDATE;

        IF p_action IS NOT NULL THEN
            PERFORM bazaar_validate_action(p_user_id, p_stock_id, p_action, p_quantity, NULL);
        END IF;

        SELECT * INTO v_res FROM bazaar_limit_reservation(p_user_id, p_stock_id, p_side, p_quantity, v_limit);
        v_total := v_res.reserved_cash + v_res.reserved_margin;
        IF v_total > v_cash THEN
            RAISE EXCEPTION USING
                MESSAGE = CASE WHEN v_res.reserved_margin > 0 THEN 'INSUFFICIENT_MARGIN' ELSE 'INSUFFICIENT_FUNDS' END,
                DETAIL = format('This order needs %s more than your available cash.',
                    to_char(v_total - v_cash, 'FM999999999990.00'));
        END IF;

        v_cash := v_cash - v_total;
        v_frozen := v_frozen + v_total;
        UPDATE users SET cash_balance = v_cash, frozen_balance = v_frozen WHERE id = p_user_id;

        INSERT INTO orders (user_id, stock_id, side, order_type, quantity, limit_price, reserved_cash, reserved_margin, action)
        VALUES (p_user_id, p_stock_id, p_side, 'limit', p_quantity, v_limit, v_res.reserved_cash, v_res.reserved_margin, p_action)
        RETURNING id INTO v_order_id;

        IF p_price IS NOT NULL AND (
            (p_side = 'buy' AND p_price <= v_limit) OR (p_side = 'sell' AND p_price >= v_limit)
        ) THEN
            RETURN bazaar_execute_fill(v_order_id, p_price);
        END IF;

        RETURN jsonb_build_object(
            'status', 'pending',
            'order_id', v_order_id,
            'user_id', p_user_id,
            'stock_id', p_stock_id,
            'side', p_side,
            'order_type', 'limit',
            'action', p_action,
            'quantity', p_quantity,
            'limit_price', v_limit,
            'reserved_cash', v_res.reserved_cash,
            'reserved_margin', v_res.reserved_margin,
            'cash_balance', v_cash,
            'frozen_balance', v_frozen
        );
    END
    $$
    `;

	// Cancels (by the owner) or rejects (by the matcher, p_user_id NULL) a
	// pending order and returns its reservation to cash. The status guard makes
	// it race-safe against a concurrent fill: whichever locks the order first
	// wins, and the other sees it is no longer pending.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_release_order(
        p_order_id BIGINT, p_user_id TEXT, p_status TEXT, p_reason TEXT)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        o orders%ROWTYPE;
        v_cash NUMERIC(15, 2);
        v_frozen NUMERIC(15, 2);
    BEGIN
        SELECT * INTO o FROM orders
        WHERE id = p_order_id AND (p_user_id IS NULL OR user_id = p_user_id)
        FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ORDER_NOT_FOUND', DETAIL = 'Order not found.';
        END IF;
        IF o.status <> 'pending' THEN
            RAISE EXCEPTION USING MESSAGE = 'ORDER_NOT_PENDING', DETAIL = format('Order is already %s.', o.status);
        END IF;

        UPDATE users
        SET cash_balance = cash_balance + o.reserved_cash + o.reserved_margin,
            frozen_balance = frozen_balance - o.reserved_cash - o.reserved_margin
        WHERE id = o.user_id
        RETURNING cash_balance, frozen_balance INTO v_cash, v_frozen;

        UPDATE orders
        SET status = p_status,
            reject_reason = p_reason,
            reserved_cash = 0,
            reserved_margin = 0,
            cancelled_at = CASE WHEN p_status = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = o.id;

        RETURN jsonb_build_object(
            'status', p_status,
            'order_id', o.id,
            'user_id', o.user_id,
            'stock_id', o.stock_id,
            'reason', p_reason,
            'cash_balance', v_cash,
            'frozen_balance', v_frozen
        );
    END
    $$
    `;

	// Changes a resting limit order's quantity and/or price in place, re-sizing
	// its reservation in the same transaction.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_modify_order(
        p_order_id BIGINT, p_user_id TEXT, p_quantity INTEGER, p_limit NUMERIC)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        o orders%ROWTYPE;
        m market%ROWTYPE;
        v_cash NUMERIC(15, 2);
        v_frozen NUMERIC(15, 2);
        v_quantity INTEGER;
        v_limit NUMERIC(15, 2);
        v_res RECORD;
        v_total NUMERIC(15, 2);
    BEGIN
        SELECT * INTO o FROM orders WHERE id = p_order_id AND user_id = p_user_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ORDER_NOT_FOUND', DETAIL = 'Order not found.';
        END IF;
        IF o.status <> 'pending' THEN
            RAISE EXCEPTION USING MESSAGE = 'ORDER_NOT_PENDING', DETAIL = format('Order is already %s.', o.status);
        END IF;

        SELECT * INTO m FROM market WHERE id = 1;
        IF m.is_paused THEN
            RAISE EXCEPTION USING MESSAGE = 'MARKET_PAUSED', DETAIL = 'The market is paused.';
        END IF;

        v_quantity := COALESCE(p_quantity, o.quantity);
        v_limit := round(COALESCE(p_limit, o.limit_price), 2);
        IF v_quantity > m.max_order_quantity THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                DETAIL = format('Orders are limited to %s shares.', m.max_order_quantity);
        END IF;

        SELECT cash_balance, frozen_balance INTO v_cash, v_frozen
        FROM users WHERE id = o.user_id FOR NO KEY UPDATE;

        IF o.action IS NOT NULL THEN
            PERFORM bazaar_validate_action(o.user_id, o.stock_id, o.action, v_quantity, o.id);
        END IF;

        -- Release the old reservation, then take the new one.
        v_cash := v_cash + o.reserved_cash + o.reserved_margin;
        v_frozen := v_frozen - o.reserved_cash - o.reserved_margin;

        SELECT * INTO v_res FROM bazaar_limit_reservation(o.user_id, o.stock_id, o.side, v_quantity, v_limit);
        v_total := v_res.reserved_cash + v_res.reserved_margin;
        IF v_total > v_cash THEN
            RAISE EXCEPTION USING
                MESSAGE = CASE WHEN v_res.reserved_margin > 0 THEN 'INSUFFICIENT_MARGIN' ELSE 'INSUFFICIENT_FUNDS' END,
                DETAIL = format('This order needs %s more than your available cash.',
                    to_char(v_total - v_cash, 'FM999999999990.00'));
        END IF;

        v_cash := v_cash - v_total;
        v_frozen := v_frozen + v_total;
        UPDATE users SET cash_balance = v_cash, frozen_balance = v_frozen WHERE id = o.user_id;

        UPDATE orders
        SET quantity = v_quantity,
            limit_price = v_limit,
            reserved_cash = v_res.reserved_cash,
            reserved_margin = v_res.reserved_margin,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = o.id;

        RETURN jsonb_build_object(
            'status', 'pending',
            'order_id', o.id,
            'user_id', o.user_id,
            'stock_id', o.stock_id,
            'side', o.side,
            'order_type', 'limit',
            'quantity', v_quantity,
            'limit_price', v_limit,
            'reserved_cash', v_res.reserved_cash,
            'reserved_margin', v_res.reserved_margin,
            'cash_balance', v_cash,
            'frozen_balance', v_frozen
        );
    END
    $$
    `;
};

const migrateWatchlistsAndAlerts = async () => {
	await sql`
    CREATE TABLE IF NOT EXISTS watchlists (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(60) NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
	await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS watchlists_user_name_idx ON watchlists (user_id, LOWER(name))
    `;

	await sql`
    CREATE TABLE IF NOT EXISTS watchlist_items (
        id SERIAL PRIMARY KEY,
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (watchlist_id, stock_id)
    )`;

	// baseline_price is the price when the alert was set. It decides the
	// direction when the player does not, so an alert never fires on the price
	// it was created at.
	await sql`
    CREATE TABLE IF NOT EXISTS price_alerts (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
        target_price NUMERIC(15, 2) NOT NULL CHECK (target_price > 0),
        direction VARCHAR(5) NOT NULL CHECK (direction IN ('above', 'below')),
        baseline_price NUMERIC(15, 2),
        note VARCHAR(140),
        status VARCHAR(10) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'triggered', 'cancelled')),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        triggered_at TIMESTAMP,
        triggered_price NUMERIC(15, 2)
    )`;
	await sql`
    CREATE INDEX IF NOT EXISTS price_alerts_user_idx ON price_alerts (user_id, created_at DESC)
    `;
	await sql`
    CREATE INDEX IF NOT EXISTS price_alerts_active_idx ON price_alerts (stock_id) WHERE status = 'active'
    `;

	// Net worth over time, for the equity curve. captured_at is wall clock, as
	// are candle timestamps, but candles only exist while the market trades, so
	// the two series do not line up point for point.
	await sql`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cash_balance NUMERIC(15, 2) NOT NULL,
        frozen_balance NUMERIC(15, 2) NOT NULL,
        holdings_value NUMERIC(15, 2) NOT NULL DEFAULT 0,
        short_exposure NUMERIC(15, 2) NOT NULL DEFAULT 0,
        realized_pnl NUMERIC(15, 2) NOT NULL DEFAULT 0,
        unrealized_pnl NUMERIC(15, 2) NOT NULL DEFAULT 0,
        net_worth NUMERIC(15, 2) NOT NULL,
        captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
	await sql`
    CREATE INDEX IF NOT EXISTS portfolio_snapshots_user_time_idx
        ON portfolio_snapshots (user_id, captured_at DESC)
    `;
};

/**
 * IPO subscriptions.
 *
 * Money stays in frozen_balance the whole way: the full bid is held on apply,
 * the unallotted part is refunded at allotment, and the allotted part stays
 * held until listing, when it turns into shares. So a player's net worth never
 * dips between allotment and listing. What an application holds is
 * amount_blocked - refund_amount while it is applied, allotted or partial.
 *
 * Lock order: ipo -> users. Order fills never lock an ipo row, so the two paths
 * cannot deadlock. Apply locks the ipo FOR SHARE so closing or allotting (which
 * lock it FOR NO KEY UPDATE) waits for in-flight applications, and vice versa.
 */
const migrateIpoApplications = async () => {
	await sql`
    CREATE TABLE IF NOT EXISTS ipo_applications (
        id BIGSERIAL PRIMARY KEY,
        ipo_id INTEGER NOT NULL REFERENCES ipo(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lots INTEGER NOT NULL CHECK (lots > 0),
        lot_size INTEGER NOT NULL CHECK (lot_size > 0),
        bid_price NUMERIC(15, 2) NOT NULL CHECK (bid_price > 0),
        amount_blocked NUMERIC(15, 2) NOT NULL CHECK (amount_blocked >= 0),
        allotted_lots INTEGER NOT NULL DEFAULT 0 CHECK (allotted_lots >= 0),
        allotment_price NUMERIC(15, 2),
        refund_amount NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
        status VARCHAR(10) NOT NULL DEFAULT 'applied'
            CHECK (status IN ('applied', 'withdrawn', 'allotted', 'partial', 'rejected', 'listed')),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (ipo_id, user_id),
        CONSTRAINT ipo_applications_allotment_within_bid CHECK (allotted_lots <= lots)
    )`;
	await sql`
    CREATE INDEX IF NOT EXISTS ipo_applications_user_idx ON ipo_applications (user_id, created_at DESC)
    `;

	// An IPO's logo, stored like a stock's and copied to the stock on listing.
	await sql`ALTER TABLE ipo ADD COLUMN IF NOT EXISTS logo_url TEXT`;
	await sql`
    CREATE TABLE IF NOT EXISTS ipo_logos (
        ipo_id INTEGER PRIMARY KEY REFERENCES ipo(id) ON DELETE CASCADE,
        content_type VARCHAR(20) NOT NULL,
        data BYTEA NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;

	await sql`ALTER TABLE ipo ADD COLUMN IF NOT EXISTS allotment_price NUMERIC(15, 2)`;
	await sql`ALTER TABLE ipo ADD COLUMN IF NOT EXISTS allotment_completed_at TIMESTAMP`;
	await sql`
    ALTER TABLE ipo
    ADD COLUMN IF NOT EXISTS listed_stock_id INTEGER REFERENCES stocks(id) ON DELETE SET NULL
    `;

	await sql`
    CREATE OR REPLACE FUNCTION bazaar_apply_ipo(
        p_user_id TEXT, p_ipo_id INTEGER, p_lots INTEGER, p_bid_price NUMERIC)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        i ipo%ROWTYPE;
        v_bid NUMERIC(15, 2);
        v_amount NUMERIC(15, 2);
        v_cash NUMERIC(15, 2);
        v_frozen NUMERIC(15, 2);
        v_app_id BIGINT;
    BEGIN
        SELECT * INTO i FROM ipo WHERE id = p_ipo_id FOR SHARE;
        IF NOT FOUND OR i.status = 'dormant' THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_FOUND', DETAIL = 'IPO not found.';
        END IF;
        -- Also refused after allotment, even if an admin reopens it: allotment
        -- runs once, so a later application could never be allotted or listed.
        IF i.status <> 'open' OR NOT i.is_open_to_subscription OR i.allotment_completed_at IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_OPEN', DETAIL = 'This IPO is not open for subscription.';
        END IF;

        v_bid := round(COALESCE(p_bid_price, i.max_price), 2);
        IF v_bid < i.min_price OR v_bid > i.max_price THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT',
                DETAIL = format('Bid between %s and %s.', i.min_price, i.max_price);
        END IF;
        IF p_lots < 1 OR p_lots::bigint * i.lot_size > i.shares_offered THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_QUANTITY',
                DETAIL = format('Apply for between 1 and %s lots.', GREATEST(i.shares_offered / i.lot_size, 1));
        END IF;

        v_amount := round(p_lots * i.lot_size * v_bid, 2);

        SELECT cash_balance, frozen_balance INTO v_cash, v_frozen
        FROM users WHERE id = p_user_id FOR NO KEY UPDATE;
        IF v_amount > v_cash THEN
            RAISE EXCEPTION USING MESSAGE = 'INSUFFICIENT_FUNDS',
                DETAIL = format('This application needs %s more than your available cash.',
                    to_char(v_amount - v_cash, 'FM999999999990.00'));
        END IF;

        -- One application per player per IPO. A withdrawn one is reused, so a
        -- player can withdraw and re-apply; it goes to the back of the queue
        -- (created_at breaks allotment ties). A live one blocks re-applying:
        -- the WHERE fails, no row comes back and v_app_id stays NULL.
        INSERT INTO ipo_applications (ipo_id, user_id, lots, lot_size, bid_price, amount_blocked)
        VALUES (p_ipo_id, p_user_id, p_lots, i.lot_size, v_bid, v_amount)
        ON CONFLICT (ipo_id, user_id) DO UPDATE SET
            lots = EXCLUDED.lots,
            lot_size = EXCLUDED.lot_size,
            bid_price = EXCLUDED.bid_price,
            amount_blocked = EXCLUDED.amount_blocked,
            allotted_lots = 0,
            allotment_price = NULL,
            refund_amount = 0,
            status = 'applied',
            created_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE ipo_applications.status = 'withdrawn'
        RETURNING id INTO v_app_id;

        IF v_app_id IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'ALREADY_APPLIED',
                DETAIL = 'You have already applied. Withdraw first to change your application.';
        END IF;

        v_cash := v_cash - v_amount;
        v_frozen := v_frozen + v_amount;
        UPDATE users SET cash_balance = v_cash, frozen_balance = v_frozen WHERE id = p_user_id;

        RETURN jsonb_build_object(
            'application_id', v_app_id, 'ipo_id', p_ipo_id, 'status', 'applied',
            'lots', p_lots, 'lot_size', i.lot_size, 'bid_price', v_bid, 'amount_blocked', v_amount,
            'cash_balance', v_cash, 'frozen_balance', v_frozen);
    END
    $$
    `;

	// Players withdraw while the IPO is open. The admin path (p_user_id NULL)
	// refunds every live application, for a withdrawn IPO, including allotted
	// ones not yet listed.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_withdraw_ipo_applications(p_ipo_id INTEGER, p_user_id TEXT)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        i ipo%ROWTYPE;
        v_count INTEGER;
        v_refunded NUMERIC(15, 2);
    BEGIN
        SELECT * INTO i FROM ipo WHERE id = p_ipo_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_FOUND', DETAIL = 'IPO not found.';
        END IF;
        IF p_user_id IS NOT NULL AND (i.status <> 'open' OR i.allotment_completed_at IS NOT NULL) THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_OPEN',
                DETAIL = 'Applications can only be withdrawn while the IPO is open.';
        END IF;

        -- RETURNING sees the row after the update, so what each application
        -- still holds is read first. Applications of this IPO only change under
        -- its row lock, held above, so this read cannot go stale.
        WITH live AS (
            SELECT id, user_id, amount_blocked - refund_amount AS held
            FROM ipo_applications
            WHERE ipo_id = p_ipo_id
              AND (p_user_id IS NULL OR user_id = p_user_id)
              AND status IN ('applied', 'allotted', 'partial')
        ),
        released AS (
            UPDATE ipo_applications a
            SET status = 'withdrawn',
                refund_amount = a.amount_blocked,
                allotted_lots = 0,
                updated_at = CURRENT_TIMESTAMP
            FROM live
            WHERE a.id = live.id
            RETURNING live.user_id, live.held
        ),
        refunds AS (
            UPDATE users u
            SET cash_balance = u.cash_balance + r.held,
                frozen_balance = u.frozen_balance - r.held
            FROM released r
            WHERE u.id = r.user_id
            RETURNING r.held
        )
        SELECT count(*), COALESCE(SUM(held), 0) INTO v_count, v_refunded FROM refunds;

        IF p_user_id IS NOT NULL AND v_count = 0 THEN
            RAISE EXCEPTION USING MESSAGE = 'APPLICATION_NOT_FOUND', DETAIL = 'You have no live application for this IPO.';
        END IF;

        RETURN jsonb_build_object('ipo_id', p_ipo_id, 'withdrawn', v_count, 'refunded', v_refunded);
    END
    $$
    `;

	await sql`
    CREATE OR REPLACE FUNCTION bazaar_run_ipo_allotment(p_ipo_id INTEGER, p_price NUMERIC)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        i ipo%ROWTYPE;
        v_price NUMERIC(15, 2);
        v_offered_lots BIGINT;
        v_total_lots BIGINT;
        v_allottees INTEGER;
        v_allotted_lots BIGINT;
        v_refunded NUMERIC(15, 2);
    BEGIN
        SELECT * INTO i FROM ipo WHERE id = p_ipo_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_FOUND', DETAIL = 'IPO not found.';
        END IF;
        IF i.status <> 'closed' THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_CLOSED', DETAIL = 'Close the IPO before running allotment.';
        END IF;
        IF i.allotment_completed_at IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'ALLOTMENT_DONE', DETAIL = 'Allotment has already run for this IPO.';
        END IF;

        v_price := round(COALESCE(p_price, i.max_price), 2);
        IF v_price < i.min_price OR v_price > i.max_price THEN
            RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT',
                DETAIL = format('The allotment price must be between %s and %s.', i.min_price, i.max_price);
        END IF;
        v_offered_lots := i.shares_offered / i.lot_size;

        -- Bids below the allotment price get nothing.
        UPDATE ipo_applications SET allotted_lots = 0
        WHERE ipo_id = p_ipo_id AND status = 'applied' AND bid_price < v_price;

        SELECT COALESCE(SUM(lots), 0) INTO v_total_lots
        FROM ipo_applications
        WHERE ipo_id = p_ipo_id AND status = 'applied' AND bid_price >= v_price;

        IF v_total_lots <= v_offered_lots THEN
            UPDATE ipo_applications SET allotted_lots = lots
            WHERE ipo_id = p_ipo_id AND status = 'applied' AND bid_price >= v_price;
        ELSE
            -- Oversubscribed: pro rata by lots, rounded down, then the lots left
            -- over go one each to the largest remainders (earliest first on a
            -- tie), so exactly v_offered_lots are allotted.
            WITH eligible AS (
                SELECT id, created_at,
                       lots::numeric * v_offered_lots / v_total_lots AS share
                FROM ipo_applications
                WHERE ipo_id = p_ipo_id AND status = 'applied' AND bid_price >= v_price
            ),
            floored AS (
                SELECT id, created_at, floor(share)::int AS base, share - floor(share) AS remainder
                FROM eligible
            ),
            leftover AS (
                SELECT v_offered_lots - SUM(base) AS n FROM floored
            ),
            ranked AS (
                SELECT f.id,
                       f.base + CASE WHEN row_number() OVER (ORDER BY f.remainder DESC, f.created_at, f.id)
                                         <= (SELECT n FROM leftover) THEN 1 ELSE 0 END AS allot
                FROM floored f
            )
            UPDATE ipo_applications a SET allotted_lots = r.allot
            FROM ranked r WHERE a.id = r.id;
        END IF;

        -- Refund everything except what the allotted lots cost at the allotment
        -- price. That part stays frozen until listing.
        WITH settled AS (
            UPDATE ipo_applications a
            SET allotment_price = v_price,
                refund_amount = a.amount_blocked - round(a.allotted_lots * a.lot_size * v_price, 2),
                status = CASE
                    WHEN a.allotted_lots = 0 THEN 'rejected'
                    WHEN a.allotted_lots < a.lots THEN 'partial'
                    ELSE 'allotted' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE a.ipo_id = p_ipo_id AND a.status = 'applied'
            RETURNING a.user_id, a.allotted_lots, a.refund_amount
        ),
        refunds AS (
            UPDATE users u
            SET cash_balance = u.cash_balance + s.refund_amount,
                frozen_balance = u.frozen_balance - s.refund_amount
            FROM settled s
            WHERE u.id = s.user_id
            RETURNING s.allotted_lots, s.refund_amount
        )
        SELECT count(*) FILTER (WHERE allotted_lots > 0), COALESCE(SUM(allotted_lots), 0), COALESCE(SUM(refund_amount), 0)
        INTO v_allottees, v_allotted_lots, v_refunded
        FROM refunds;

        UPDATE ipo
        SET allotment_price = v_price,
            allotment_completed_at = CURRENT_TIMESTAMP,
            is_open_to_subscription = FALSE,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_ipo_id;

        RETURN jsonb_build_object(
            'ipo_id', p_ipo_id,
            'allotment_price', v_price,
            'offered_lots', v_offered_lots,
            'applied_lots', v_total_lots,
            'allotted_lots', v_allotted_lots,
            'allottees', v_allottees,
            'refunded', v_refunded);
    END
    $$
    `;

	// Creates the stock and turns every allotment into shares. Refused while
	// applications are still waiting for allotment, so listing can never strand
	// a player's frozen cash.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_list_ipo(p_ipo_id INTEGER, p_volatility NUMERIC)
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
        i ipo%ROWTYPE;
        v_listing_price NUMERIC(15, 2);
        v_stock_id INTEGER;
        v_credited INTEGER;
    BEGIN
        SELECT * INTO i FROM ipo WHERE id = p_ipo_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_NOT_FOUND', DETAIL = 'IPO not found.';
        END IF;
        IF i.status = 'listed' THEN
            RAISE EXCEPTION USING MESSAGE = 'IPO_ALREADY_LISTED', DETAIL = 'This IPO is already listed.';
        END IF;
        IF EXISTS (SELECT 1 FROM ipo_applications WHERE ipo_id = p_ipo_id AND status = 'applied') THEN
            RAISE EXCEPTION USING MESSAGE = 'ALLOTMENT_PENDING',
                DETAIL = 'Close the IPO and run allotment before listing it.';
        END IF;
        IF EXISTS (SELECT 1 FROM stocks WHERE symbol = i.symbol) THEN
            RAISE EXCEPTION USING MESSAGE = 'SYMBOL_TAKEN',
                DETAIL = format('A stock with symbol %s already exists.', i.symbol);
        END IF;

        v_listing_price := COALESCE(NULLIF(i.listing_price, 0), i.allotment_price, i.max_price);

        INSERT INTO stocks (name, symbol, sector, volatility, locked, last_price, last_price_at)
        VALUES (i.name, i.symbol, i.sector, COALESCE(p_volatility, 0), FALSE, v_listing_price, CURRENT_TIMESTAMP)
        RETURNING id INTO v_stock_id;

        INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price)
        VALUES (v_stock_id, v_listing_price, v_listing_price, v_listing_price, v_listing_price);

        -- The IPO's logo becomes the stock's, at the URL stocks serve logos from.
        INSERT INTO stock_logos (stock_id, content_type, data, updated_at)
        SELECT v_stock_id, l.content_type, l.data, CURRENT_TIMESTAMP
        FROM ipo_logos l WHERE l.ipo_id = p_ipo_id;
        IF FOUND THEN
            UPDATE stocks
            SET logo_url = format('/stocks/logo/%s?v=%s', v_stock_id,
                                  floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
            WHERE id = v_stock_id;
        END IF;

        -- Allotted shares at the allotment price (their cost basis); trading
        -- starts at the listing price, so the difference is the listing gain.
        WITH credited AS (
            UPDATE ipo_applications a
            SET status = 'listed', updated_at = CURRENT_TIMESTAMP
            WHERE a.ipo_id = p_ipo_id AND a.status IN ('allotted', 'partial')
            RETURNING a.user_id, a.allotted_lots * a.lot_size AS shares, a.allotment_price,
                      a.amount_blocked - a.refund_amount AS held
        ),
        positions AS (
            INSERT INTO user_portfolios (user_id, stock_id, volume, average_price, margin_locked, opened_at, updated_at)
            SELECT user_id, v_stock_id, shares, allotment_price, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM credited WHERE shares > 0
            RETURNING user_id
        ),
        ledger AS (
            INSERT INTO user_stock_transactions (user_id, stock_id, volume, price, transaction_type, realized_pnl)
            SELECT user_id, v_stock_id, shares, allotment_price, 'buy', 0
            FROM credited WHERE shares > 0
            RETURNING user_id
        ),
        paid AS (
            UPDATE users u
            SET frozen_balance = u.frozen_balance - c.held
            FROM credited c
            WHERE u.id = c.user_id
            RETURNING u.id
        )
        SELECT count(*) INTO v_credited FROM paid;

        UPDATE ipo
        SET status = 'listed',
            is_open_to_subscription = FALSE,
            listed_stock_id = v_stock_id,
            listing_price = v_listing_price,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = p_ipo_id;

        RETURN jsonb_build_object(
            'ipo_id', p_ipo_id, 'stock_id', v_stock_id,
            'listing_price', v_listing_price, 'credited_users', v_credited);
    END
    $$
    `;
};

/**
 * The latest simulated price, written by the stock engine every tick.
 *
 * stock_ohlc is only written when ENABLE_STOCK_DB_UPDATES is on, so with it off
 * the table stays frozen at seed prices. Anything that needs "the price now"
 * (order fills, valuations, the leaderboard) reads this column instead.
 */
/**
 * The price a stock started trading at: its seed price, the price an admin
 * listed it at, or its IPO listing price. Players see every change measured
 * from here, so it never moves once set.
 */
const migrateStartingPrice = async () => {
	await sql`ALTER TABLE stocks ADD COLUMN IF NOT EXISTS starting_price NUMERIC(15, 2)`;

	// Existing stocks: the last candle at the moment the stock was created. The
	// seed script writes simulated history that ends there, and addStock and IPO
	// listing write a single candle at creation. Failing that, the oldest candle.
	await sql`
    UPDATE stocks s
    SET starting_price = COALESCE(
        (SELECT o.close_price FROM stock_ohlc o
            WHERE o.stock_id = s.id AND o.timestamp <= s.created_at + INTERVAL '1 minute'
            ORDER BY o.timestamp DESC LIMIT 1),
        (SELECT o.open_price FROM stock_ohlc o
            WHERE o.stock_id = s.id
            ORDER BY o.timestamp ASC LIMIT 1),
        s.last_price
    )
    WHERE s.starting_price IS NULL
    `;

	// New stocks, however they are inserted, start at their first price.
	await sql`
    CREATE OR REPLACE FUNCTION bazaar_set_starting_price()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
        NEW.starting_price := COALESCE(NEW.starting_price, NEW.last_price);
        RETURN NEW;
    END;
    $$
    `;
	await sql`DROP TRIGGER IF EXISTS stocks_starting_price ON stocks`;
	await sql`
    CREATE TRIGGER stocks_starting_price
    BEFORE INSERT ON stocks
    FOR EACH ROW EXECUTE FUNCTION bazaar_set_starting_price()
    `;
};

/**
 * News moves prices over a chosen time: each story has a default duration and
 * each affected stock may override it (affected_stocks entries become
 * {"impact_pct", "duration_seconds"} keyed by stock id; the older
 * {"SYMBOL": pct} form is still read).
 *
 * first_released_at marks that a story has gone out and its impact has been
 * applied, which happens exactly once: hiding and re-releasing it does not move
 * prices again, and the scheduler never re-releases a hidden story.
 */
/**
 * First-login onboarding and profile photos.
 *
 * users.onboarded_at is stamped when a player confirms their name (and
 * optionally a photo) after approval; trading waits for it. Accounts that
 * already existed when the column arrived keep playing without the dialog, so
 * the backfill only runs the one time the column is created.
 *
 * Photos live in user_avatars as small WebP/PNG/JPEG bytes and are served from
 * /users/avatar/:id, so users.image (which the leaderboard sends every two
 * seconds) stays a short URL.
 */
const migrateUserProfiles = async () => {
	const existing = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'onboarded_at'
    `;
	if (existing.length === 0) {
		await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ`;
		await sql`UPDATE users SET onboarded_at = NOW() WHERE role <> 'pending'`;
	}
	await sql`
    CREATE TABLE IF NOT EXISTS user_avatars (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        content_type VARCHAR(20) NOT NULL,
        data BYTEA NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
	// Photos uploaded before avatar URLs became paths carry whatever BACKEND_URL
	// was then. Only our own photos are rewritten: users.image can also hold a
	// sign-in provider's picture, which must stay a full URL.
	await sql`
    UPDATE users u
    SET image = regexp_replace(u.image, '^https?://[^/]+(/users/avatar/)', '\\1')
    WHERE u.image ~ '^https?://[^/]+/users/avatar/'
      AND EXISTS (SELECT 1 FROM user_avatars a WHERE a.user_id = u.id)
    `;
	await sql`
    CREATE INDEX IF NOT EXISTS users_created_at_idx ON users ("createdAt" DESC)
    `;
	// Set by an organiser for test or house accounts: they keep playing but are
	// left out of the ranking, as organisers are.
	await sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_from_leaderboard BOOLEAN NOT NULL DEFAULT FALSE
    `;
	// Every god-mode action an organiser takes on someone else's account. The
	// names are copied in rather than joined: the point of the trail is to still
	// read correctly after an account is deleted, and ON DELETE SET NULL keeps
	// the row when it is.
	await sql`
    CREATE TABLE IF NOT EXISTS admin_actions (
        id BIGSERIAL PRIMARY KEY,
        admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        admin_name TEXT NOT NULL,
        action VARCHAR(40) NOT NULL,
        target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        target_user_name TEXT,
        summary TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
	await sql`
    CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at DESC)
    `;
	await sql`
    CREATE INDEX IF NOT EXISTS admin_actions_target_idx ON admin_actions (target_user_id, created_at DESC)
    `;
};

const migrateNewsImpacts = async () => {
	await sql`
    ALTER TABLE news
    ADD COLUMN IF NOT EXISTS impact_duration_seconds INTEGER NOT NULL DEFAULT 60
    `;
	await sql`ALTER TABLE news ADD COLUMN IF NOT EXISTS first_released_at TIMESTAMP`;
	// Released before this column existed: already out, never apply it again.
	await sql`
    UPDATE news SET first_released_at = release_at
    WHERE is_released AND first_released_at IS NULL
    `;
	// Updating a story without impacts once wrote a JSON null over them.
	await sql`
    UPDATE news SET affected_stocks = '{}'::jsonb
    WHERE jsonb_typeof(affected_stocks) IS DISTINCT FROM 'object'
    `;
};

const migrateLivePrice = async () => {
	await sql`ALTER TABLE stocks ADD COLUMN IF NOT EXISTS last_price NUMERIC(15, 2)`;
	await sql`ALTER TABLE stocks ADD COLUMN IF NOT EXISTS last_price_at TIMESTAMP`;

	// Seed it from the newest candle so it is never empty before the first tick.
	await sql`
    UPDATE stocks s
    SET last_price = latest.close_price, last_price_at = CURRENT_TIMESTAMP
    FROM (
        SELECT DISTINCT ON (stock_id) stock_id, close_price
        FROM stock_ohlc
        ORDER BY stock_id, timestamp DESC
    ) latest
    WHERE s.id = latest.stock_id AND s.last_price IS NULL
    `;
};
