import sql from "../database/database.js";
import { computeIndexSnapshot } from "../marketIndex.js";
import type {
	IndexBasis,
	IndexHistory,
	IndexSnapshot,
	MarketOverview,
	SectorSnapshot,
	StockSnapshot,
} from "../models/market.js";
import { getLatestIndex, getLiveMarketData } from "../stockEngine.js";
import { getMarketState } from "./market.js";

// A candle covers 10 seconds, so the default window looks back over the last
// 15 minutes of trading.
const DEFAULT_OVERVIEW_CANDLES = 90;
const MAX_OVERVIEW_CANDLES = 1000;
const TOP_MOVERS = 5;

const num = (value: unknown): number => Number(value ?? 0);

type SeriesPoint = {
	open: number;
	high: number;
	low: number;
	close: number;
	timestamp: string;
};

const clampWindow = (candles: number) =>
	Math.min(
		Math.max(Math.trunc(candles) || DEFAULT_OVERVIEW_CANDLES, 2),
		MAX_OVERVIEW_CANDLES,
	);

/** Each stock's starting price by id: the reference players measure every change from. */
const fetchStartingPrices = async () => {
	const rows = await sql`
		SELECT id, starting_price::float8 AS starting_price
		FROM stocks
		WHERE starting_price > 0
	`;
	return new Map(rows.map((row) => [Number(row.id), Number(row.starting_price)]));
};

/**
 * The Bazaar index right now: the engine's snapshot from its latest tick, or,
 * before it has ticked (a paused market after a restart), the same calculation
 * over the last prices it wrote.
 */
export const getCurrentIndex = async (): Promise<IndexSnapshot> => {
	const latest = getLatestIndex();
	if (latest) return latest;
	const rows = await sql`
		SELECT
			id,
			sector,
			last_price::float8 AS last_price,
			starting_price::float8 AS starting_price
		FROM stocks
	`;
	return computeIndexSnapshot(
		rows.map((row) => ({
			stockId: Number(row.id),
			sector: String(row.sector),
			price: row.last_price === null ? null : Number(row.last_price),
			startingPrice:
				row.starting_price === null ? null : Number(row.starting_price),
		})),
	);
};

/**
 * The candles every reading on the market page is derived from: what has been
 * persisted, plus whatever the engine still holds in memory and the candle it
 * is building right now.
 *
 * The in-memory half matters because ENABLE_STOCK_DB_UPDATES can be off, in
 * which case the table never moves while the simulation does. Timestamps decide
 * what is already known, so turning persistence on changes nothing here.
 */
const fetchCandleSeries = async (limit: number) => {
	// NUMERIC columns are cast to float8 because the driver hands them back as
	// strings, which would concatenate instead of adding.
	const rows = await sql`
		SELECT
			stock_id,
			open_price::float8 AS open_price,
			high_price::float8 AS high_price,
			low_price::float8 AS low_price,
			close_price::float8 AS close_price,
			timestamp
		FROM (
			SELECT
				stock_id,
				open_price,
				high_price,
				low_price,
				close_price,
				timestamp,
				ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY timestamp DESC) AS rn
			FROM stock_ohlc
		) ranked
		WHERE rn <= ${limit}
		ORDER BY stock_id, timestamp ASC
	`;

	const series = new Map<number, SeriesPoint[]>();
	for (const row of rows) {
		const stockId = Number(row.stock_id);
		const points = series.get(stockId) ?? [];
		points.push({
			open: Number(row.open_price),
			high: Number(row.high_price),
			low: Number(row.low_price),
			close: Number(row.close_price),
			timestamp: new Date(row.timestamp as string).toISOString(),
		});
		series.set(stockId, points);
	}

	for (const [stockId, live] of getLiveMarketData()) {
		const points = series.get(stockId) ?? [];
		const seen = new Set(points.map((point) => point.timestamp));

		const candles = live.current ? [...live.recent, live.current] : live.recent;
		for (const candle of candles) {
			const timestamp = new Date(candle.timestamp).toISOString();
			if (seen.has(timestamp)) continue;
			seen.add(timestamp);
			points.push({
				open: Number(candle.open_price),
				high: Number(candle.high_price),
				low: Number(candle.low_price),
				close: Number(candle.close_price),
				timestamp,
			});
		}

		points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		series.set(stockId, points.slice(-limit));
	}

	return series;
};

/**
 * The equal weighted index over time. Each stock is normalised against the open
 * of its own oldest candle in the window, so a Rs.2000 stock cannot drown out a
 * Rs.20 one and the series always starts at 100.
 *
 * Candles are aligned by position rather than by timestamp because every stock
 * is stepped by the same simulator loop, so their candles come in lockstep.
 */
const aggregateIndex = (
	series: Map<number, SeriesPoint[]>,
	// Starting prices by stock id; without them each stock's window open.
	bases?: Map<number, number>,
): IndexHistory["points"] => {
	const lengths = [...series.values()].map((points) => points.length);
	const longest = lengths.length ? Math.max(...lengths) : 0;

	const history: IndexHistory["points"] = [];
	// Walk back from the newest candle so the most recent points always line up,
	// even for a stock that was listed part way through the window.
	for (let offset = longest - 1; offset >= 0; offset--) {
		let total = 0;
		let contributors = 0;
		let timestamp: string | null = null;

		for (const [stockId, points] of series) {
			const position = points.length - 1 - offset;
			if (position < 0) continue;

			const base = bases ? bases.get(stockId) : points[0].open;
			if (!base) continue;

			total += points[position].close / base;
			contributors++;
			const candidate = points[position].timestamp;
			if (!timestamp || candidate > timestamp) timestamp = candidate;
		}

		if (contributors && timestamp) {
			const value = (total / contributors) * 100;
			// How far this point is from 100, the start of its basis.
			history.push({ timestamp, value, change_pct: value - 100 });
		}
	}

	return history;
};

const toSnapshot = (
	row: Record<string, unknown>,
	points: SeriesPoint[],
): StockSnapshot => {
	const first = points[0];
	const last = points[points.length - 1];
	const reference = first ? first.open : null;
	const current = last ? last.close : null;
	const canCompare = current !== null && reference !== null && reference !== 0;

	return {
		id: Number(row.id),
		symbol: row.symbol as string,
		name: row.name as string,
		sector: row.sector as string,
		locked: Boolean(row.locked),
		current_price: current,
		reference_price: reference,
		change: canCompare ? current - reference : null,
		change_pct: canCompare ? ((current - reference) / reference) * 100 : null,
		window_high: points.length
			? Math.max(...points.map((point) => point.high))
			: null,
		window_low: points.length
			? Math.min(...points.map((point) => point.low))
			: null,
		candle_count: points.length,
	};
};

const meanChangePct = (stocks: StockSnapshot[]): number | null =>
	stocks.length
		? stocks.reduce((total, stock) => total + (stock.change_pct ?? 0), 0) /
			stocks.length
		: null;

const summarizeSectors = (stocks: StockSnapshot[]): SectorSnapshot[] => {
	const bySector = new Map<string, StockSnapshot[]>();
	for (const stock of stocks) {
		const members = bySector.get(stock.sector) ?? [];
		members.push(stock);
		bySector.set(stock.sector, members);
	}

	const sectors: SectorSnapshot[] = [];
	for (const [sector, members] of bySector) {
		const priced = members.filter((stock) => stock.change_pct !== null);
		sectors.push({
			sector,
			stock_count: members.length,
			advancing: priced.filter((stock) => (stock.change_pct ?? 0) > 0).length,
			declining: priced.filter((stock) => (stock.change_pct ?? 0) < 0).length,
			change_pct: meanChangePct(priced),
		});
	}

	// Strongest sector first, sectors with no priced stocks last.
	return sectors.sort(
		(a, b) =>
			(b.change_pct ?? Number.NEGATIVE_INFINITY) -
			(a.change_pct ?? Number.NEGATIVE_INFINITY),
	);
};

/**
 * A single read-only snapshot of the whole market: an equal weighted index,
 * breadth, movers, sector performance, trading activity and the capital the
 * participants are holding.
 *
 * Movement is measured over a window of the most recent candles rather than a
 * wall clock interval, so time the market spent paused or closed (when no
 * candles are made) does not count towards it.
 */
export const getMarketOverview = async (
	candles = DEFAULT_OVERVIEW_CANDLES,
): Promise<MarketOverview> => {
	const windowCandles = clampWindow(candles);
	const [series, currentIndex] = await Promise.all([
		fetchCandleSeries(windowCandles),
		getCurrentIndex(),
	]);

	const [
		state,
		stockRows,
		activityRows,
		participantRows,
		holdingRows,
		newsRows,
		ipoRows,
	] = await Promise.all([
		getMarketState(),
		sql`
			SELECT id, symbol, name, sector, locked
			FROM stocks
			ORDER BY symbol
		`,
		sql`
			SELECT
				COUNT(*)::int AS trade_count,
				COUNT(DISTINCT user_id)::int AS traders,
				COALESCE(SUM(volume), 0)::float8 AS total_volume,
				COALESCE(SUM(volume * price), 0)::float8 AS total_value,
				COALESCE(SUM(volume) FILTER (WHERE transaction_type IN ('buy', 'cover')), 0)::float8 AS buy_volume,
				COALESCE(SUM(volume) FILTER (WHERE transaction_type IN ('sell', 'short')), 0)::float8 AS sell_volume
			FROM user_stock_transactions
		`,
		sql`
			SELECT
				COUNT(*)::int AS total_users,
				COUNT(*) FILTER (WHERE role IS DISTINCT FROM 'pending')::int AS approved_users,
				COUNT(*) FILTER (WHERE role = 'pending')::int AS pending_users,
				COALESCE(SUM(cash_balance), 0)::float8 AS total_cash,
				COALESCE(SUM(frozen_balance), 0)::float8 AS total_frozen
			FROM users
		`,
		// Valued at stocks.last_price, the engine's live price. stock_ohlc is
		// frozen at seed prices when ENABLE_STOCK_DB_UPDATES is off. Shorts have
		// a negative volume, so longs and shorts are summed separately rather
		// than netted against each other.
		sql`
			SELECT
				COUNT(DISTINCT p.user_id)::int AS investors,
				COALESCE(SUM(p.volume) FILTER (WHERE p.volume > 0), 0)::float8 AS shares_held,
				COALESCE(SUM(-p.volume) FILTER (WHERE p.volume < 0), 0)::float8 AS shares_short,
				COALESCE(SUM(p.volume * COALESCE(s.last_price, p.average_price))
					FILTER (WHERE p.volume > 0), 0)::float8 AS holdings_value,
				COALESCE(SUM(-p.volume * COALESCE(s.last_price, p.average_price))
					FILTER (WHERE p.volume < 0), 0)::float8 AS short_exposure,
				COALESCE(SUM((p.average_price - COALESCE(s.last_price, p.average_price)) * -p.volume)
					FILTER (WHERE p.volume < 0), 0)::float8 AS short_pnl,
				COALESCE(SUM(p.margin_locked), 0)::float8 AS margin_locked
			FROM user_portfolios p
			JOIN stocks s ON s.id = p.stock_id
			WHERE p.volume <> 0
		`,
		sql`
			SELECT
				COUNT(*) FILTER (WHERE is_released)::int AS released,
				COUNT(*) FILTER (WHERE NOT is_released)::int AS scheduled,
				MIN(release_at) FILTER (WHERE NOT is_released) AS next_release_at
			FROM news
		`,
		sql`
			SELECT
				COUNT(*)::int AS total,
				COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
				COUNT(*) FILTER (WHERE status = 'upcoming')::int AS upcoming_count,
				COUNT(*) FILTER (WHERE status = 'listed')::int AS listed_count
			FROM ipo
		`,
	]);

	const stocks = stockRows.map((row) =>
		toSnapshot(row, series.get(Number(row.id)) ?? []),
	);
	const priced = stocks.filter((stock) => stock.change_pct !== null);
	const ranked = [...priced].sort(
		(a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0),
	);

	// The same index snapshot the engine pushes to both apps every tick.
	// How far it moved over the window alone, for the movers beside it.
	const windowPoints = aggregateIndex(series);
	const windowLevel = windowPoints.length
		? windowPoints[windowPoints.length - 1].value
		: null;

	const withPrice = stocks.filter((stock) => stock.current_price !== null);
	const averagePrice = withPrice.length
		? withPrice.reduce(
				(total, stock) => total + (stock.current_price ?? 0),
				0,
			) / withPrice.length
		: null;

	const activity = activityRows[0];
	const participants = participantRows[0];
	const holdings = holdingRows[0];
	const news = newsRows[0];
	const ipos = ipoRows[0];

	const totalCash = num(participants.total_cash);
	const holdingsValue = num(holdings.holdings_value);

	return {
		state,
		generated_at: new Date().toISOString(),
		window_candles: windowCandles,
		index: {
			level: currentIndex.level,
			change_pct: currentIndex.change_pct,
			basis: "start",
			window_change_pct: windowLevel === null ? null : windowLevel - 100,
			average_price: averagePrice,
			priced_stocks: priced.length,
		},
		breadth: {
			advancing: priced.filter((stock) => (stock.change_pct ?? 0) > 0).length,
			declining: priced.filter((stock) => (stock.change_pct ?? 0) < 0).length,
			unchanged: priced.filter((stock) => stock.change_pct === 0).length,
			total: stocks.length,
		},
		stocks,
		// Split by sign rather than taking both ends of the ranking, so a rising
		// stock never shows up under the losers in a market with few stocks.
		top_gainers: ranked
			.filter((stock) => (stock.change_pct ?? 0) > 0)
			.slice(0, TOP_MOVERS),
		top_losers: ranked
			.filter((stock) => (stock.change_pct ?? 0) < 0)
			.slice(-TOP_MOVERS)
			.reverse(),
		sectors: summarizeSectors(stocks),
		activity: {
			trade_count: num(activity.trade_count),
			traders: num(activity.traders),
			total_volume: num(activity.total_volume),
			total_value: num(activity.total_value),
			buy_volume: num(activity.buy_volume),
			sell_volume: num(activity.sell_volume),
		},
		participants: {
			total_users: num(participants.total_users),
			approved_users: num(participants.approved_users),
			pending_users: num(participants.pending_users),
			investors: num(holdings.investors),
			total_cash: totalCash,
			total_frozen: num(participants.total_frozen),
			holdings_value: holdingsValue,
			shares_held: num(holdings.shares_held),
			shares_short: num(holdings.shares_short),
			short_exposure: num(holdings.short_exposure),
			margin_locked: num(holdings.margin_locked),
			// Same formula as the leaderboard: frozen holds margin and reserved
			// cash, and a short contributes only its P&L.
			net_worth:
				totalCash +
				num(participants.total_frozen) +
				holdingsValue +
				num(holdings.short_pnl),
		},
		news: {
			released: num(news.released),
			scheduled: num(news.scheduled),
			next_release_at: news.next_release_at
				? new Date(news.next_release_at as string).toISOString()
				: null,
		},
		ipos: {
			total: num(ipos.total),
			open: num(ipos.open_count),
			upcoming: num(ipos.upcoming_count),
			listed: num(ipos.listed_count),
		},
	};
};

/**
 * The plotted index. Built from the same merged candles and the same reference
 * price as getMarketOverview, so the curve ends exactly on the level shown
 * above it.
 */
export const getIndexHistory = async (
	points = DEFAULT_OVERVIEW_CANDLES,
	basis: IndexBasis = "window",
): Promise<IndexHistory> => {
	const limit = clampWindow(points);
	const [series, bases] = await Promise.all([
		fetchCandleSeries(limit),
		basis === "start" ? fetchStartingPrices() : Promise.resolve(undefined),
	]);

	return {
		points: aggregateIndex(series, bases),
		basis,
		window_candles: limit,
		stock_count: series.size,
	};
};
