export type MarketSentiment = "bullish" | "bearish" | "neutral";

export const MARKET_SENTIMENTS: MarketSentiment[] = [
	"bullish",
	"bearish",
	"neutral",
];

/**
 * The market table holds a single row (id = 1) describing the global state of
 * the simulation: whether the engine is halted and which way the overall market
 * is being steered.
 */
export type MarketState = {
	id: number;
	is_paused: boolean;
	sentiment: MarketSentiment;
	paused_at: string | null;
	updated_at: string;
};

export type StockSnapshot = {
	id: number;
	symbol: string;
	name: string;
	sector: string;
	locked: boolean;
	current_price: number | null;
	reference_price: number | null;
	change: number | null;
	change_pct: number | null;
	window_high: number | null;
	window_low: number | null;
	candle_count: number;
};

export type SectorSnapshot = {
	sector: string;
	stock_count: number;
	advancing: number;
	declining: number;
	change_pct: number | null;
};

/**
 * Everything an admin needs to read the state of the whole market at a glance.
 * Every price movement is measured over a window of the most recent candles
 * rather than a wall clock interval, because OHLC timestamps are simulated and
 * drift away from real time whenever the engine is paused or reseeded.
 */
export type MarketOverview = {
	state: MarketState;
	generated_at: string;
	window_candles: number;
	index: {
		level: number | null;
		change_pct: number | null;
		average_price: number | null;
		priced_stocks: number;
	};
	breadth: {
		advancing: number;
		declining: number;
		unchanged: number;
		total: number;
	};
	stocks: StockSnapshot[];
	top_gainers: StockSnapshot[];
	top_losers: StockSnapshot[];
	sectors: SectorSnapshot[];
	activity: {
		trade_count: number;
		traders: number;
		total_volume: number;
		total_value: number;
		buy_volume: number;
		sell_volume: number;
	};
	participants: {
		total_users: number;
		approved_users: number;
		pending_users: number;
		investors: number;
		total_cash: number;
		total_frozen: number;
		holdings_value: number;
		shares_held: number;
		net_worth: number;
	};
	news: {
		released: number;
		scheduled: number;
		next_release_at: string | null;
	};
	ipos: {
		total: number;
		open: number;
		upcoming: number;
		listed: number;
	};
};

export type IndexHistory = {
	points: { timestamp: string; value: number }[];
	window_candles: number;
	stock_count: number;
};
