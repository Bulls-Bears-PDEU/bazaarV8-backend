import sql from "../database/database.js";
import eventEmitter from "../eventEmitter.js";
import type {
	MarketSentiment,
	MarketState,
	TradingRules,
} from "../models/market.js";

/**
 * The stock engine reads the market state on every tick (once per second), so
 * the row is cached in memory and refreshed only when it actually changes.
 */
let cachedState: MarketState | null = null;

const normalizeState = (row: Record<string, unknown>): MarketState => ({
	id: Number(row.id),
	is_paused: Boolean(row.is_paused),
	sentiment: row.sentiment as MarketSentiment,
	paused_at: row.paused_at
		? new Date(row.paused_at as string).toISOString()
		: null,
	updated_at: new Date(row.updated_at as string).toISOString(),
	short_margin_pct: Number(row.short_margin_pct),
	allow_short_selling: Boolean(row.allow_short_selling),
	allow_limit_orders: Boolean(row.allow_limit_orders),
	max_order_quantity: Number(row.max_order_quantity),
});

const fetchMarketState = async (): Promise<MarketState> => {
	const result = await sql`SELECT * FROM market WHERE id = 1`;

	if (result.length === 0) {
		// The row is seeded during initDB, but recreate it if it ever goes missing
		// so a pause switch failure can never take the whole engine down.
		const inserted = await sql`
			INSERT INTO market (id) VALUES (1)
			ON CONFLICT (id) DO UPDATE SET id = 1
			RETURNING *
		`;
		return normalizeState(inserted[0]);
	}

	return normalizeState(result[0]);
};

export const getMarketState = async (
	forceRefresh = false,
): Promise<MarketState> => {
	if (!cachedState || forceRefresh) {
		cachedState = await fetchMarketState();
	}
	return cachedState;
};

const publishStateChange = (state: MarketState) => {
	cachedState = state;
	eventEmitter.emit("marketStateChanged", state);
};

export const setMarketPaused = async (
	isPaused: boolean,
): Promise<MarketState> => {
	const result = await sql`
		UPDATE market
		SET
			is_paused = ${isPaused},
			paused_at = ${isPaused ? new Date().toISOString() : null},
			updated_at = CURRENT_TIMESTAMP
		WHERE id = 1
		RETURNING *
	`;

	const state = normalizeState(result[0]);
	publishStateChange(state);
	console.log(`Market ${isPaused ? "paused" : "resumed"} by admin`);
	return state;
};

/**
 * Changes only apply to new orders. Open shorts keep the margin they locked,
 * so raising the rate never pulls extra cash out of existing positions.
 */
export const setTradingRules = async (
	rules: Partial<TradingRules>,
): Promise<MarketState> => {
	const result = await sql`
		UPDATE market
		SET
			short_margin_pct = COALESCE(${rules.short_margin_pct ?? null}, short_margin_pct),
			allow_short_selling = COALESCE(${rules.allow_short_selling ?? null}, allow_short_selling),
			allow_limit_orders = COALESCE(${rules.allow_limit_orders ?? null}, allow_limit_orders),
			max_order_quantity = COALESCE(${rules.max_order_quantity ?? null}, max_order_quantity),
			updated_at = CURRENT_TIMESTAMP
		WHERE id = 1
		RETURNING *
	`;

	const state = normalizeState(result[0]);
	publishStateChange(state);
	return state;
};

export const setMarketSentiment = async (
	sentiment: MarketSentiment,
): Promise<MarketState> => {
	const result = await sql`
		UPDATE market
		SET
			sentiment = ${sentiment},
			updated_at = CURRENT_TIMESTAMP
		WHERE id = 1
		RETURNING *
	`;

	const state = normalizeState(result[0]);
	publishStateChange(state);
	console.log(`Market sentiment set to ${sentiment}`);
	return state;
};
