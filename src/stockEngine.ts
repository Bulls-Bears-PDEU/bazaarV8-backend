/**
 * This file contains the logic for the stock generation engine, which makes realtime stock prices on the fly using a GBM model. The GBM model is a stochastic process that is commonly used to model stock prices. More info on the working of the model can be found in the stockEngine.md file in the docs folder.
 */

import config from "./config/config.js";
import { getMarketState } from "./controller/market.js";
import sql from "./database/database.js";
import eventEmitter from "./eventEmitter.js";
import type { MarketSentiment } from "./models/market.js";
import type { StockOHLC } from "./models/stock.js";
import { emitToAdmins, emitToMarket } from "./realtime/emitter.js";

const TIME_STEP = 1 / 907200; // Delta T
const DRIFT = 0.15; // Baseline drift, used when the market sentiment is neutral

// Admin-selected market sentiment tilts the baseline drift (mu) of every stock:
// bullish upwards, bearish downwards, neutral leaves the baseline untouched.
//
// The tilt is measured in standard deviations per hour rather than as a fixed
// percentage, because a fixed percentage disappears into the noise as soon as a
// stock is volatile: at a volatility of 13 a 6%/hour tilt competes with 84% of
// hourly noise, so a bearish market visibly rises most of the time.
const TICKS_PER_HOUR = 3600;
const SENTIMENT_SIGMA_PER_HOUR: Record<MarketSentiment, number> = {
	bullish: 1,
	bearish: -1,
	neutral: 0,
};

const driftForSentiment = (
	sentiment: MarketSentiment,
	volatility: number,
): number => {
	const horizon = TICKS_PER_HOUR * TIME_STEP;

	// GBM moves the median by (mu - sigma^2/2), so at high volatility that second
	// term alone buries the price (-30%/hour at a volatility of 13) no matter
	// which way an admin sets the sentiment. Adding it back makes neutral mean
	// flat and lets the tilt below decide the direction.
	const medianDrag = 0.5 * volatility ** 2;
	const tilt =
		((SENTIMENT_SIGMA_PER_HOUR[sentiment] ?? 0) * volatility) /
		Math.sqrt(horizon);

	return DRIFT + medianDrag + tilt;
};
const DEFAULT_TICKS_TO_AGGREGATE = 10; // Number of ticks to aggregate for OHLC generation, default is 10, which corresponds to 1 candle of 30 seconds, as the stock price is updated every second in the generateStockPrice function. So, 30 ticks will give us 1 minute of OHLC data for each stock.
// const DB_UPDATE_CANDLE_COUNT = 2;`

type Candle = Omit<StockOHLC, "id">;

type LiveStockState = {
	currentCandle: Candle;
	ticksInCurrentCandle: number;
	// Completed candles kept in memory regardless of ENABLE_STOCK_DB_UPDATES, so
	// the market overview reflects the running simulation even when nothing is
	// being persisted.
	recentCandles: Candle[];
};

const MAX_RECENT_CANDLES = 500;

const liveStockState = new Map<number, LiveStockState>();

// Store active news effects to modify drift temporarily
type NewsImpact = {
	extraDrift: number;
	expiresAt: number;
};
const activeImpacts = new Map<number | string, NewsImpact[]>();

// Listen for news releases globally (outside the simulation loop)
eventEmitter.on("newsReleased", async ({ id }: { id: number }) => {
	console.log(`Received newsReleased event for news ID ${id}`);
	try {
		const newsItem = await sql`
			SELECT affected_stocks
			FROM news
			WHERE id = ${id}
		`;

		if (newsItem.length === 0) {
			console.error(`No news found with ID ${id}`);
			return;
		}

		const affectedStocks: Record<string, number> = newsItem[0].affected_stocks;
		if (!affectedStocks) return;

		// Apply the impact over 1 minute (60 ticks if ~1 tick per sec)
		const durationMs = 60 * 1000;
		const ticksForDuration = 60;

		for (const [identifier, impact] of Object.entries(affectedStocks)) {
			// Convert raw percentage impact into drift increase over the timeline
			const extraDrift = impact / (ticksForDuration * TIME_STEP);

			const parsedId = parseInt(identifier, 10);
			const key = isNaN(parsedId) ? identifier : parsedId;

			const existing = activeImpacts.get(key) || [];
			existing.push({
				extraDrift,
				expiresAt: Date.now() + durationMs,
			});
			activeImpacts.set(key, existing);

			console.log(
				`Applied temporary drift of ${extraDrift.toFixed(4)} to stock ${identifier} for ${durationMs / 1000}s (impact: ${impact})`,
			);
		}
	} catch (error) {
		console.error("Error processing news release impact:", error);
	}
});

const sampleStandardNormal = (): number => {
	// Box-Muller transform for Z ~ N(0, 1)
	let u1 = Math.random();
	let u2 = Math.random();

	while (u1 === 0) {
		u1 = Math.random();
	}
	while (u2 === 0) {
		u2 = Math.random();
	}

	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};
/*
 * @param initialOHLC : S_{t-1} = initialOHLC.close,
 * @param volatility : σ (sigma), the volatility of the stock
 * @param drift: μ (mu), the drift of the stock
 */
export const generateStockPrice = (
	candleStick: Omit<StockOHLC, "id">,
	volatility: number,
	drift: number = DRIFT,
	noOfTicks = DEFAULT_TICKS_TO_AGGREGATE,
): Omit<StockOHLC, "id"> => {
	const openPrice = candleStick.close_price;
	let highPrice = openPrice;
	let lowPrice = openPrice;
	let closePrice = openPrice;

	for (let tick = 0; tick < noOfTicks; tick++) {
		const z = sampleStandardNormal();
		closePrice =
			closePrice *
			Math.exp(
				(drift - 0.5 * volatility ** 2) * TIME_STEP +
					volatility * z * Math.sqrt(TIME_STEP),
			);

		highPrice = Math.max(highPrice, closePrice);
		lowPrice = Math.min(lowPrice, closePrice);
	}

	// Ensure prices are rounded to 2 decimal places, as we are dealing with stock prices
	if (noOfTicks === 1) {
		return {
			stock_id: candleStick.stock_id,
			open_price: Number(Number(openPrice).toFixed(2)),
			high_price: Number(Number(highPrice).toFixed(2)),
			low_price: Number(Number(lowPrice).toFixed(2)),
			close_price: Number(Number(closePrice).toFixed(2)),
			timestamp: candleStick.timestamp, // For ticks within the same candle, we keep the timestamp same as the original candle
		};
	}
	return {
		stock_id: candleStick.stock_id,
		open_price: Number(Number(openPrice).toFixed(2)),
		high_price: Number(Number(highPrice).toFixed(2)),
		low_price: Number(Number(lowPrice).toFixed(2)),
		close_price: Number(Number(closePrice).toFixed(2)),
		timestamp: new Date(
			new Date(candleStick.timestamp).getTime() + noOfTicks * 1000,
		).toISOString(),
	};
};

/** Returns false when the stock has no candle to start from yet. */
const initializeLiveStockState = async (stockId: number): Promise<boolean> => {
	const result = await sql`
        SELECT open_price, high_price, low_price, close_price, timestamp
        FROM stock_ohlc
        WHERE stock_id = ${stockId}
        ORDER BY timestamp DESC
        LIMIT 1
    `;

	if (result.length === 0) {
		return false;
	}

	const latestCandle = result[0];

	// NUMERIC comes back from the driver as a string; the engine does arithmetic
	// on these and emits them, so they must be numbers from the first tick.
	liveStockState.set(stockId, {
		currentCandle: {
			stock_id: stockId,
			open_price: Number(latestCandle.open_price),
			high_price: Number(latestCandle.high_price),
			low_price: Number(latestCandle.low_price),
			close_price: Number(latestCandle.close_price),
			timestamp: latestCandle.timestamp,
		},
		ticksInCurrentCandle: 0,
		recentCandles: [],
	});
	return true;
};

type SimulatedStock = { id: number; symbol: string; volatility: number };

/**
 * The stock list barely ever changes but was re-queried every second. Cache it,
 * drop the cache whenever a stock is added, edited or listed ("stocksChanged"),
 * and refresh it on a timer anyway to pick up changes made outside this
 * process, such as the seed script.
 */
const STOCK_LIST_TTL_MS = 60_000;
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
	const rows = await sql`SELECT id, symbol, volatility FROM stocks`;
	const stocks = rows.map((row) => ({
		id: Number(row.id),
		symbol: String(row.symbol),
		// NUMERIC comes back from the driver as a string.
		volatility: Number(row.volatility),
	}));
	stockListCache = { stocks, loadedAt: Date.now() };
	return stocks;
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

/** Every completed candle this tick in one multi-row insert. */
const persistCandles = async (candles: Candle[]) => {
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

/**
 * The live view of the market straight from the simulator: the candle each
 * stock is currently building plus the completed ones still held in memory.
 */
export const getLiveMarketData = () => {
	const live = new Map<number, { current: Candle; recent: Candle[] }>();
	for (const [stockId, state] of liveStockState) {
		live.set(stockId, {
			current: { ...state.currentCandle },
			recent: [...state.recentCandles],
		});
	}
	return live;
};

// Wall clock at which the market was paused, so news impacts (which expire on
// wall clock time) can be extended by however long the market stood still.
let pausedSince: number | null = null;

const shiftActiveImpacts = (offsetMs: number) => {
	for (const impacts of activeImpacts.values()) {
		for (const impact of impacts) {
			impact.expiresAt += offsetMs;
		}
	}
};

// Candles whose insert failed, retried with the next batch. Capped so a long
// database outage cannot grow this without bound.
const MAX_UNSAVED_CANDLES = 5_000;
let unsavedCandles: Candle[] = [];

// Stocks with no candle to start from are skipped until they get one; warn once.
const warnedUnseededStocks = new Set<number>();

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

const runTick = async () => {
	const market = await getMarketState();

	// While the market is paused the simulation stands completely still: no new
	// ticks, no emitted prices and no OHLC rows written. Candle timestamps are
	// derived from the previous candle rather than the wall clock, so the
	// simulated clock simply resumes where it left off.
	if (market.is_paused) {
		if (pausedSince === null) {
			pausedSince = Date.now();
			console.log("Market is paused, halting stock simulation");
		}
		return;
	}

	if (pausedSince !== null) {
		shiftActiveImpacts(Date.now() - pausedSince);
		console.log(
			`Market resumed after ${((Date.now() - pausedSince) / 1000).toFixed(0)}s, restarting stock simulation`,
		);
		pausedSince = null;
	}

	const stocks = await getSimulatedStocks();

	// Every stock's candle after this tick, sent as one message, and the
	// candles that completed this tick, persisted as one insert.
	const tickCandles: Candle[] = [];
	const completedCandles: Candle[] = [];

	for (const stock of stocks) {
		const { id: stockId, symbol, volatility } = stock;

		if (!liveStockState.has(stockId)) {
			const initialized = await initializeLiveStockState(stockId);
			if (!initialized) {
				if (!warnedUnseededStocks.has(stockId)) {
					warnedUnseededStocks.add(stockId);
					console.warn(
						`Stock ${stockId} (${symbol}) has no OHLC data yet; skipping it until it does`,
					);
				}
				continue;
			}
			warnedUnseededStocks.delete(stockId);
		}

		const stockState = liveStockState.get(stockId);
		if (!stockState) {
			continue;
		}

		// Calculate current drift from the market sentiment and active news effects
		let currentDrift = driftForSentiment(market.sentiment, volatility);
		const now = Date.now();

		let idImpacts = activeImpacts.get(stockId) || [];
		if (idImpacts.length > 0) {
			idImpacts = idImpacts.filter((eff) => now < eff.expiresAt);
			if (idImpacts.length > 0) {
				activeImpacts.set(stockId, idImpacts);
			} else {
				activeImpacts.delete(stockId);
			}
			for (const eff of idImpacts) {
				currentDrift += eff.extraDrift;
			}
		}

		let symbolImpacts = activeImpacts.get(symbol) || [];
		if (symbolImpacts.length > 0) {
			symbolImpacts = symbolImpacts.filter((eff) => now < eff.expiresAt);
			if (symbolImpacts.length > 0) {
				activeImpacts.set(symbol, symbolImpacts);
			} else {
				activeImpacts.delete(symbol);
			}
			for (const eff of symbolImpacts) {
				currentDrift += eff.extraDrift;
			}
		}

		const tickResult = generateStockPrice(
			stockState.currentCandle,
			volatility,
			currentDrift,
			1,
		);
		if (stockState.ticksInCurrentCandle === 0) {
			// First tick of a new candle body: initialize open, high, low
			stockState.currentCandle = {
				...stockState.currentCandle,
				open_price: stockState.currentCandle.close_price,
				high_price: tickResult.high_price,
				low_price: tickResult.low_price,
				close_price: tickResult.close_price,
				timestamp: tickResult.timestamp,
			};
		} else {
			// Accumulate over upcoming ticks to create the candle's shadow/wicks
			stockState.currentCandle.high_price = Math.max(
				stockState.currentCandle.high_price,
				tickResult.close_price,
			);
			stockState.currentCandle.low_price = Math.min(
				stockState.currentCandle.low_price,
				tickResult.close_price,
			);
			stockState.currentCandle.close_price = tickResult.close_price;
			stockState.currentCandle.timestamp = tickResult.timestamp;
		}

		stockState.ticksInCurrentCandle++;
		const isCandleComplete =
			stockState.ticksInCurrentCandle === DEFAULT_TICKS_TO_AGGREGATE;

		if (isCandleComplete) {
			stockState.ticksInCurrentCandle = 0; // Reset tick count for the next candle
			const newDate = new Date(stockState.currentCandle.timestamp);
			newDate.setSeconds(newDate.getSeconds() + DEFAULT_TICKS_TO_AGGREGATE); // Increment timestamp by the number of ticks for the next candle
			stockState.currentCandle.timestamp = newDate.toISOString(); // Update timestamp by incrementing it by the total time covered by the ticks in the candle
		}

		const candle = { ...stockState.currentCandle };
		tickCandles.push(candle);

		// Admin panel compatibility: it still listens for one message per stock.
		// Players only get the batched marketTick below.
		emitToAdmins("stockPriceUpdate", candle);

		if (isCandleComplete) {
			// Keep the finished candle in memory whether or not it is persisted.
			stockState.recentCandles.push(candle);
			if (stockState.recentCandles.length > MAX_RECENT_CANDLES) {
				stockState.recentCandles.shift();
			}
			completedCandles.push(candle);
		}
	}

	// One message per second for the whole market, instead of one per stock.
	emitToMarket("marketTick", tickCandles);

	await persistLastPrices(tickCandles);

	if (config.ENABLE_STOCK_DB_UPDATES && completedCandles.length > 0) {
		const batch = [...unsavedCandles, ...completedCandles];
		try {
			await persistCandles(batch);
			unsavedCandles = [];
		} catch (error) {
			unsavedCandles = batch.slice(-MAX_UNSAVED_CANDLES);
			console.error(
				`Failed to save ${batch.length} candles, will retry next candle:`,
				error,
			);
		}
	}
};
