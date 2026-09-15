/**
 * The stock engine. Ticks every stock once a second while the market is open
 * and publishes the result: one batched marketTick for players, per-stock
 * updates for admins, the live price that orders fill at, and 10 second
 * candles for the charts.
 *
 * The model is geometric Brownian motion in log price, tuned for a game that
 * runs for about nine hours of trading, over which it plays out about a month
 * of a real market. On top of it:
 *
 *   - correlated moves: a market factor and a sector factor, so the index and
 *     each sector move together the way they do on a real exchange
 *   - volatility regimes: each stock drifts between calm and busy spells
 *   - admin sentiment: a repricing when it changes, then a drift, both measured
 *     in standard deviations and eased in over a couple of minutes instead of
 *     kinking every chart at once
 *   - news: a percentage move priced in over the following minute, with a
 *     burst of volatility after it
 *
 * The engine keeps no clock of its own: the market trades whenever an admin
 * has it open, and stands still while it is paused.
 */

import config from "./config/config.js";
import { getMarketState } from "./controller/market.js";
import sql from "./database/database.js";
import eventEmitter from "./eventEmitter.js";
import { computeIndexSnapshot, sinceStart } from "./marketIndex.js";
import type { IndexSnapshot, MarketSentiment } from "./models/market.js";
import type { StockOHLC } from "./models/stock.js";
import { emitToAdmins, emitToMarket } from "./realtime/emitter.js";
import { checkAlerts } from "./trading/alerts.js";
import { matchTick } from "./trading/matcher.js";

// ---------------------------------------------------------------------------
// Ticks and candles
// ---------------------------------------------------------------------------

/** app.ts runs the simulator on this interval; each run is one tick. */
export const TICK_INTERVAL_MS = 1000;

/**
 * Candles are cut on the wall clock, so a chart's time axis reads real time
 * and a pause shows up as a gap rather than being squeezed out.
 */
export const CANDLE_MS = 10_000;

const TICKS_PER_HOUR = 3_600_000 / TICK_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

// The length of game the engine is tuned for, in hours of open market.
// Nothing enforces it; it only sets how fast prices move.
const SESSION_HOURS = 9;
const SESSION_TICKS = SESSION_HOURS * TICKS_PER_HOUR;

// Stock volatility is annualised, the way it is quoted for real stocks, and a
// session plays out this many trading days of it. This is the main dial for
// how lively the game is: at 21, a typical large cap (0.25) moves about 2.4%
// an hour and 7% over nine hours, and a volatile name (0.45) about 4% an hour.
const TRADING_DAYS_PER_YEAR = 252;
const TRADING_DAYS_PER_SESSION = 21;
const YEARS_PER_TICK =
	TRADING_DAYS_PER_SESSION / TRADING_DAYS_PER_YEAR / SESSION_TICKS;
const SQRT_YEARS_PER_TICK = Math.sqrt(YEARS_PER_TICK);

// The long-run equity return, so a neutral market leans very slightly upwards
// (about 1% over a session) instead of being a pure coin toss.
const ANNUAL_DRIFT = 0.12;

// Sentiment works in two parts, both measured in each stock's own hourly
// standard deviations so it shows on calm and volatile stocks alike.
//
// A change of sentiment is first repriced: every stock moves this many hourly
// sigmas as the new sentiment eases in (about 0.7% for a typical large cap,
// twice that for a flip from bearish to bullish). A drift alone grows with
// time while the noise grows with its square root, so it would take the best
// part of an hour to show; the repricing is what makes the market react.
// A few minutes into a bullish market about nine stocks in ten are up.
const SENTIMENT_REPRICE_SIGMAS = 0.3;
// Then it keeps tilting every stock by this many hourly sigmas per hour, so
// the trend carries on: an hour in, about nine stocks in ten are still up and
// nine hours of it adds about 20% to a typical large cap.
const SENTIMENT_SIGMAS_PER_HOUR = 1;
const SENTIMENT_DIRECTION: Record<MarketSentiment, number> = {
	bullish: 1,
	bearish: -1,
	neutral: 0,
};
// Time constant of the ease into a new sentiment, in ticks: two thirds of the
// repricing lands in the first minute and 95% within three.
const SENTIMENT_EASE_TICKS = 60;

// How each stock's variance splits between the whole market, its sector and
// itself. Two stocks in one sector correlate at just under 0.5 and in
// different sectors just under 0.3 (each stock's volatility regime is its own,
// which takes a little off), close to what NSE large caps do.
const MARKET_SHARE = 0.3;
const SECTOR_SHARE = 0.2;
const MARKET_LOADING = Math.sqrt(MARKET_SHARE);
const SECTOR_LOADING = Math.sqrt(SECTOR_SHARE);
const OWN_LOADING = Math.sqrt(1 - MARKET_SHARE - SECTOR_SHARE);

// Volatility regimes: a multiplier on each stock's volatility that wanders
// between calm and busy spells (a log-normal Ornstein-Uhlenbeck process) and
// reverts with a 15 minute half-life. Its mean square is 1, so over a few
// hours it neither adds nor removes volatility.
const REGIME_HALF_LIFE_TICKS = (15 * 60 * 1000) / TICK_INTERVAL_MS;
const REGIME_SPREAD = 0.3;
const REGIME_REVERSION = Math.LN2 / REGIME_HALF_LIFE_TICKS;
const REGIME_SHOCK = REGIME_SPREAD * Math.sqrt(1 - (1 - REGIME_REVERSION) ** 2);
const REGIME_MEAN = -(REGIME_SPREAD ** 2);

// News impacts are percentages: {"RELIANCE": 4} moves Reliance up 4%. The move
// is priced in with this time constant in ticks, so 95% of it lands within
// 45 seconds, and it doubles the stock's volatility, which then fades with the
// regime half-life.
const NEWS_ABSORB_TICKS = 15;
const NEWS_ABSORB_RATE = 1 - Math.exp(-1 / NEWS_ABSORB_TICKS);
const NEWS_VOLATILITY_KICK = Math.LN2;
const MAX_NEWS_IMPACT_PCT = 50;

// Used for a stock with no usable volatility, such as an IPO listed without one.
const DEFAULT_VOLATILITY = 0.3;
const MIN_VOLATILITY = 0.05;
const MAX_VOLATILITY = 1;

const STOCK_LIST_TTL_MS = 60_000;
// Enough for the market overview's largest window.
const MAX_RECENT_CANDLES = 1_000;
// Candles whose insert failed, retried with the next batch. Capped so a long
// database outage cannot grow this without bound.
const MAX_UNSAVED_CANDLES = 5_000;

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

const roundToPaisa = (value: number) => Math.round(value * 100) / 100;

let spareNormal: number | null = null;

/** Z ~ N(0, 1) by Box-Muller, which yields two per draw; the second is kept. */
const standardNormal = (): number => {
	if (spareNormal !== null) {
		const value = spareNormal;
		spareNormal = null;
		return value;
	}
	let u1 = Math.random();
	while (u1 === 0) u1 = Math.random();
	const u2 = Math.random();
	const radius = Math.sqrt(-2 * Math.log(u1));
	spareNormal = radius * Math.sin(2 * Math.PI * u2);
	return radius * Math.cos(2 * Math.PI * u2);
};

/**
 * Stocks once stored volatility as a whole percentage (20 for 20%), while the
 * model needs a decimal sigma (0.20), so both are accepted.
 */
const normalizeVolatility = (value: number) => {
	const sigma = value > 1 ? value / 100 : value;
	if (!Number.isFinite(sigma) || sigma <= 0) return DEFAULT_VOLATILITY;
	return clamp(sigma, MIN_VOLATILITY, MAX_VOLATILITY);
};

const nextRegime = (logRegime: number) =>
	REGIME_MEAN +
	(logRegime - REGIME_MEAN) * (1 - REGIME_REVERSION) +
	REGIME_SHOCK * standardNormal();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Candle = Omit<StockOHLC, "id">;

type SimulatedStock = {
	id: number;
	symbol: string;
	sector: string;
	volatility: number;
	// What the Bazaar index measures this stock from; null until it has one.
	startingPrice: number | null;
};

type LiveStockState = {
	// Unrounded, so moves smaller than a paisa still add up.
	logPrice: number;
	// The last published price, rounded to the paisa.
	price: number;
	logRegime: number;
	// Log move from released news still to be priced in.
	pendingNews: number;
	// The candle being built; null while the market is paused.
	candle: Candle | null;
	// Start of the open candle, or of the last one when none is open (ms).
	candleStart: number;
	// Completed candles kept in memory regardless of ENABLE_STOCK_DB_UPDATES,
	// so the market overview follows the simulation even when nothing is saved.
	recentCandles: Candle[];
};

const liveStockState = new Map<number, LiveStockState>();

// Log moves from news released since the last tick, by stock id.
const newsQueue = new Map<number, number>();

// Stocks with no price to start from, skipped until the stock list reloads.
const unpricedStocks = new Set<number>();
const warnedUnpricedStocks = new Set<number>();

let sentimentLevel: number | null = null;
// The index after the latest tick, for the API. Null until the first tick.
let latestIndex: IndexSnapshot | null = null;
// Wall clock at which the market was paused, for the resume log.
let pausedSince: number | null = null;
let unsavedCandles: Candle[] = [];

// ---------------------------------------------------------------------------
// Stocks
// ---------------------------------------------------------------------------

/**
 * The stock list barely ever changes, so it is cached. Adding, editing,
 * listing or deleting a stock drops the cache ("stocksChanged"), and it is
 * refreshed on a timer anyway to pick up changes made outside this process,
 * such as the seed script.
 */
let stockListCache: { stocks: SimulatedStock[]; loadedAt: number } | null =
	null;

eventEmitter.on("stocksChanged", () => {
	stockListCache = null;
});

const getSimulatedStocks = async (): Promise<SimulatedStock[]> => {
	if (
		stockListCache &&
		Date.now() - stockListCache.loadedAt < STOCK_LIST_TTL_MS
	) {
		return stockListCache.stocks;
	}
	const rows = await sql`
		SELECT
			id,
			symbol,
			sector,
			volatility::float8 AS volatility,
			starting_price::float8 AS starting_price
		FROM stocks
		ORDER BY id
	`;
	const stocks = rows.map((row) => ({
		id: Number(row.id),
		symbol: String(row.symbol),
		sector: String(row.sector),
		volatility: normalizeVolatility(Number(row.volatility)),
		startingPrice:
			row.starting_price === null ? null : Number(row.starting_price),
	}));
	stockListCache = { stocks, loadedAt: Date.now() };

	// Forget deleted stocks, and try the unpriced ones again.
	const ids = new Set(stocks.map((stock) => stock.id));
	for (const id of liveStockState.keys()) {
		if (!ids.has(id)) liveStockState.delete(id);
	}
	for (const id of newsQueue.keys()) {
		if (!ids.has(id)) newsQueue.delete(id);
	}
	unpricedStocks.clear();
	return stocks;
};

/**
 * Picks up where the database left off: the engine's last price (or the last
 * candle, for a stock it has never ticked) and the last candle's time, so new
 * candles never go back in time. One query for every new stock.
 */
const initializeStocks = async (stocks: SimulatedStock[]) => {
	const ids = stocks
		.map((stock) => stock.id)
		.filter((id) => !liveStockState.has(id) && !unpricedStocks.has(id));
	if (ids.length === 0) return;

	const rows = await sql`
		SELECT
			s.id,
			COALESCE(s.last_price, latest.close_price)::float8 AS price,
			(EXTRACT(EPOCH FROM latest.timestamp) * 1000)::float8 AS last_candle_ms
		FROM stocks s
		LEFT JOIN LATERAL (
			SELECT close_price, timestamp
			FROM stock_ohlc
			WHERE stock_id = s.id
			ORDER BY timestamp DESC
			LIMIT 1
		) latest ON TRUE
		WHERE s.id = ANY(${ids}::int[])
	`;

	const pending = new Set(ids);
	for (const row of rows) {
		const stockId = Number(row.id);
		const price = Number(row.price);
		if (!Number.isFinite(price) || price <= 0) continue;

		liveStockState.set(stockId, {
			logPrice: Math.log(price),
			price: roundToPaisa(price),
			logRegime: REGIME_MEAN,
			pendingNews: 0,
			candle: null,
			candleStart: Number(row.last_candle_ms ?? 0),
			recentCandles: [],
		});
		pending.delete(stockId);
		warnedUnpricedStocks.delete(stockId);
	}

	for (const stockId of pending) {
		unpricedStocks.add(stockId);
		if (!warnedUnpricedStocks.has(stockId)) {
			warnedUnpricedStocks.add(stockId);
			const symbol = stocks.find((stock) => stock.id === stockId)?.symbol;
			console.warn(
				`Stock ${stockId} (${symbol}) has no price yet; skipping it until it does`,
			);
		}
	}
};

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

/**
 * Queues each affected stock's move for the next tick. Stocks may be given by
 * id or by symbol, and the impact is a percentage.
 */
const queueNewsImpact = async (newsId: number) => {
	const rows = await sql`SELECT affected_stocks FROM news WHERE id = ${newsId}`;
	if (rows.length === 0) {
		console.error(`No news found with ID ${newsId}`);
		return;
	}
	const affected = rows[0].affected_stocks as Record<string, unknown> | null;
	if (!affected) return;

	const stocks = await getSimulatedStocks();
	const symbolsById = new Map(stocks.map((stock) => [stock.id, stock.symbol]));
	const idsBySymbol = new Map(
		stocks.map((stock) => [stock.symbol.toUpperCase(), stock.id]),
	);

	for (const [key, value] of Object.entries(affected)) {
		const identifier = key.trim();
		const stockId = /^\d+$/.test(identifier)
			? Number(identifier)
			: idsBySymbol.get(identifier.toUpperCase());
		const symbol = stockId === undefined ? undefined : symbolsById.get(stockId);
		if (stockId === undefined || symbol === undefined) {
			console.warn(`News ${newsId}: no stock "${key}", impact ignored`);
			continue;
		}
		const impactPct = Number(value);
		if (!Number.isFinite(impactPct)) {
			console.warn(`News ${newsId}: impact for ${key} is not a number`);
			continue;
		}

		const bounded = clamp(impactPct, -MAX_NEWS_IMPACT_PCT, MAX_NEWS_IMPACT_PCT);
		newsQueue.set(
			stockId,
			(newsQueue.get(stockId) ?? 0) + Math.log1p(bounded / 100),
		);
		console.log(
			`News ${newsId}: ${symbol} ${bounded > 0 ? "+" : ""}${bounded}%`,
		);
	}
};

eventEmitter.on("newsReleased", ({ id }: { id: number }) => {
	queueNewsImpact(id).catch((error) => {
		console.error("Error processing news release impact:", error);
	});
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Moves the sentiment level a step towards the admin's setting and returns it
 * with the step taken, which is what gets repriced. On the first tick the
 * level starts at the setting with no step, since the stored prices already
 * reflect whatever sentiment the market had before a restart.
 */
const easeSentiment = (sentiment: MarketSentiment) => {
	const target = SENTIMENT_DIRECTION[sentiment] ?? 0;
	const previous = sentimentLevel ?? target;
	sentimentLevel = previous + (target - previous) / SENTIMENT_EASE_TICKS;
	return { level: sentimentLevel, change: sentimentLevel - previous };
};

type TickShocks = {
	market: number;
	sector: number;
	sentiment: { level: number; change: number };
};

/** Moves one stock's price by one tick. */
const stepPrice = (
	state: LiveStockState,
	stock: SimulatedStock,
	shocks: TickShocks,
) => {
	const sigma = stock.volatility;

	const news = newsQueue.get(stock.id);
	if (news !== undefined) {
		newsQueue.delete(stock.id);
		state.pendingNews += news;
		state.logRegime += NEWS_VOLATILITY_KICK;
	}
	const newsMove = state.pendingNews * NEWS_ABSORB_RATE;
	state.pendingNews =
		Math.abs(state.pendingNews - newsMove) < 1e-6
			? 0
			: state.pendingNews - newsMove;

	state.logRegime = nextRegime(state.logRegime);

	const hourlySigma = sigma * SQRT_YEARS_PER_TICK * Math.sqrt(TICKS_PER_HOUR);
	const drift =
		ANNUAL_DRIFT * YEARS_PER_TICK +
		(shocks.sentiment.level * SENTIMENT_SIGMAS_PER_HOUR * hourlySigma) /
			TICKS_PER_HOUR +
		shocks.sentiment.change * SENTIMENT_REPRICE_SIGMAS * hourlySigma;
	const tickVolatility =
		sigma * Math.exp(state.logRegime) * SQRT_YEARS_PER_TICK;
	const shock =
		MARKET_LOADING * shocks.market +
		SECTOR_LOADING * shocks.sector +
		OWN_LOADING * standardNormal();

	state.logPrice += drift + tickVolatility * shock + newsMove;
	state.price = roundToPaisa(Math.exp(state.logPrice));
};

/** Closes the open candle into the recent history and returns it. */
const finishCandle = (state: LiveStockState): Candle | null => {
	const candle = state.candle;
	if (!candle) return null;
	state.candle = null;
	state.recentCandles.push(candle);
	if (state.recentCandles.length > MAX_RECENT_CANDLES) {
		state.recentCandles.shift();
	}
	return candle;
};

/**
 * Adds the tick's price to the stock's candle, starting a new candle when the
 * wall clock has moved into the next 10 second slot. Returns the candle that
 * finished, if one did.
 */
const recordTick = (
	state: LiveStockState,
	stockId: number,
	previousPrice: number,
	slotStart: number,
): Candle | null => {
	const finished =
		state.candle && slotStart > state.candleStart ? finishCandle(state) : null;

	if (state.candle) {
		state.candle.high_price = Math.max(state.candle.high_price, state.price);
		state.candle.low_price = Math.min(state.candle.low_price, state.price);
		state.candle.close_price = state.price;
		return finished;
	}

	// Never before the previous candle, even if stored history runs ahead of
	// the wall clock; the slots catch up with the clock by themselves.
	state.candleStart = Math.max(slotStart, state.candleStart + CANDLE_MS);
	state.candle = {
		stock_id: stockId,
		open_price: previousPrice,
		high_price: Math.max(previousPrice, state.price),
		low_price: Math.min(previousPrice, state.price),
		close_price: state.price,
		timestamp: new Date(state.candleStart).toISOString(),
	};
	return finished;
};

/**
 * One statement per tick for every stock, instead of one per stock. This is
 * what order fills and valuations read, since stock_ohlc may not be written.
 */
const persistLastPrices = async (candles: Candle[]) => {
	if (candles.length === 0) return;
	const ids = candles.map((candle) => candle.stock_id);
	const prices = candles.map((candle) => candle.close_price);
	await sql`
		UPDATE stocks s
		SET last_price = t.price, last_price_at = CURRENT_TIMESTAMP
		FROM UNNEST(${ids}::int[], ${prices}::numeric[]) AS t(id, price)
		WHERE s.id = t.id
	`;
};

/** Any number of candles in one multi-row insert. */
export const persistCandles = async (candles: Candle[]) => {
	if (candles.length === 0) return;
	await sql`
		INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
		SELECT * FROM UNNEST(
			${candles.map((c) => c.stock_id)}::int[],
			${candles.map((c) => c.open_price)}::numeric[],
			${candles.map((c) => c.high_price)}::numeric[],
			${candles.map((c) => c.low_price)}::numeric[],
			${candles.map((c) => c.close_price)}::numeric[],
			${candles.map((c) => c.timestamp)}::timestamp[]
		)
	`;
};

const saveCandles = async (completed: Candle[]) => {
	if (!config.ENABLE_STOCK_DB_UPDATES || completed.length === 0) return;
	const batch = [...unsavedCandles, ...completed];
	try {
		await persistCandles(batch);
		unsavedCandles = [];
	} catch (error) {
		unsavedCandles = batch.slice(-MAX_UNSAVED_CANDLES);
		console.error(
			`Failed to save ${batch.length} candles, will retry with the next ones:`,
			error,
		);
	}
};

/** Finishes every open candle, so none is lost while the market is shut. */
const closeOpenCandles = async () => {
	const completed: Candle[] = [];
	for (const state of liveStockState.values()) {
		const candle = finishCandle(state);
		if (candle) completed.push(candle);
	}
	await saveCandles(completed);
};

const runTick = async () => {
	const now = new Date();
	const market = await getMarketState();

	// While the market is paused the simulation stands completely still: no
	// ticks, no emitted prices and no candles.
	if (market.is_paused) {
		if (pausedSince === null) {
			pausedSince = now.getTime();
			console.log("Market is paused, halting stock simulation");
			await closeOpenCandles();
		}
		return;
	}
	if (pausedSince !== null) {
		console.log(
			`Market resumed after ${((now.getTime() - pausedSince) / 1000).toFixed(0)}s, restarting stock simulation`,
		);
		pausedSince = null;
	}

	const stocks = await getSimulatedStocks();
	await initializeStocks(stocks);

	const sentiment = easeSentiment(market.sentiment);
	const marketShock = standardNormal();
	const sectorShocks = new Map<string, number>();
	const slotStart = Math.floor(now.getTime() / CANDLE_MS) * CANDLE_MS;

	// Every stock's candle after this tick, sent as one message, and the
	// candles that finished this tick, saved as one insert.
	const tickCandles: Candle[] = [];
	// The same candles with the move since the starting price, for players.
	const playerCandles: (Candle & {
		change: number | null;
		change_pct: number | null;
	})[] = [];
	const completedCandles: Candle[] = [];

	for (const stock of stocks) {
		const state = liveStockState.get(stock.id);
		if (!state) continue;

		let sectorShock = sectorShocks.get(stock.sector);
		if (sectorShock === undefined) {
			sectorShock = standardNormal();
			sectorShocks.set(stock.sector, sectorShock);
		}

		const previousPrice = state.price;
		stepPrice(state, stock, {
			market: marketShock,
			sector: sectorShock,
			sentiment,
		});
		const finished = recordTick(state, stock.id, previousPrice, slotStart);
		if (finished) completedCandles.push(finished);

		const candle = { ...(state.candle as Candle) };
		tickCandles.push(candle);
		// Players see every move measured from the starting price; it is worked
		// out here, once, and travels with the candle.
		const move = sinceStart(state.price, stock.startingPrice);
		playerCandles.push({
			...candle,
			change: move?.change ?? null,
			change_pct: move?.change_pct ?? null,
		});
		// Admin panel compatibility: it still listens for one message per
		// stock. Players only get the batched marketTick below.
		emitToAdmins("stockPriceUpdate", candle);
	}

	// One message per second for the whole market, instead of one per stock.
	emitToMarket("marketTick", playerCandles);

	// The index from the prices this tick produced, so every screen shows the
	// same figure without working it out itself.
	latestIndex = computeIndexSnapshot(
		stocks.map((stock) => ({
			stockId: stock.id,
			sector: stock.sector,
			price: liveStockState.get(stock.id)?.price,
			startingPrice: stock.startingPrice,
		})),
		now,
	);
	emitToMarket("indexTick", latestIndex);

	// In-memory only: queues crossing limit orders and alerts for the drain in
	// app.ts, so fills never slow the tick down.
	matchTick(tickCandles);
	checkAlerts(tickCandles);

	await persistLastPrices(tickCandles);
	await saveCandles(completedCandles);
};

// setInterval does not wait for the previous tick. If a tick is slow (a slow
// database write), skip the next one rather than running two over the same
// in-memory state.
let isTicking = false;

export const stockSimulator = async () => {
	if (isTicking) return;
	isTicking = true;
	try {
		await runTick();
	} finally {
		isTicking = false;
	}
};

// ---------------------------------------------------------------------------
// Reads for the rest of the app
// ---------------------------------------------------------------------------

/**
 * The live view of the market straight from the simulator: the candle each
 * stock is building (null while the market is shut) and the completed ones
 * still held in memory.
 */
export const getLiveMarketData = () => {
	const live = new Map<number, { current: Candle | null; recent: Candle[] }>();
	for (const [stockId, state] of liveStockState) {
		live.set(stockId, {
			current: state.candle ? { ...state.candle } : null,
			recent: [...state.recentCandles],
		});
	}
	return live;
};

/** The index as of the latest tick, or null before the engine has ticked. */
export const getLatestIndex = (): IndexSnapshot | null => latestIndex;

/**
 * The price a stock last ticked at, or undefined before the engine has loaded
 * it. Cheap, unlike getLiveMarketData(), which copies every candle history.
 */
export const getLivePrice = (stockId: number): number | undefined =>
	liveStockState.get(stockId)?.price;

/**
 * Past trading for the seed script: `candles` 10 second candles ending just
 * before `endAt` and closing exactly at `endPrice`. Drawn from the live
 * calibration, so a seeded chart runs seamlessly into the live one.
 */
export const simulateHistory = ({
	stockId,
	endPrice,
	volatility,
	candles,
	endAt = new Date(),
}: {
	stockId: number;
	endPrice: number;
	volatility: number;
	candles: number;
	endAt?: Date;
}): Candle[] => {
	const sigma = normalizeVolatility(volatility);
	const ticksPerCandle = CANDLE_MS / TICK_INTERVAL_MS;

	const logPrices = [0];
	let logRegime = REGIME_MEAN;
	for (let tick = 0; tick < candles * ticksPerCandle; tick++) {
		logRegime = nextRegime(logRegime);
		logPrices.push(
			logPrices[tick] +
				ANNUAL_DRIFT * YEARS_PER_TICK +
				sigma * Math.exp(logRegime) * SQRT_YEARS_PER_TICK * standardNormal(),
		);
	}

	// Shift the whole path so it lands on endPrice.
	const shift = Math.log(endPrice) - logPrices[logPrices.length - 1];
	const prices = logPrices.map((logPrice) =>
		roundToPaisa(Math.exp(logPrice + shift)),
	);

	const lastStart =
		Math.floor(endAt.getTime() / CANDLE_MS) * CANDLE_MS - CANDLE_MS;
	const history: Candle[] = [];
	for (let index = 0; index < candles; index++) {
		// Each candle opens at the previous one's close.
		const ticks = prices.slice(
			index * ticksPerCandle,
			(index + 1) * ticksPerCandle + 1,
		);
		history.push({
			stock_id: stockId,
			open_price: ticks[0],
			high_price: Math.max(...ticks),
			low_price: Math.min(...ticks),
			close_price: ticks[ticks.length - 1],
			timestamp: new Date(
				lastStart - (candles - 1 - index) * CANDLE_MS,
			).toISOString(),
		});
	}
	return history;
};
