/**
 * This file contains the logic for the stock generation engine, which makes realtime stock prices on the fly using a GBM model. The GBM model is a stochastic process that is commonly used to model stock prices. More info on the working of the model can be found in the stockEngine.md file in the docs folder.
 */

import type { Server } from "socket.io";
import sql from "./database/database.js";
import config from "./config/config.js";
import type { StockOHLC } from "./models/stock.js";
import eventEmitter from "./eventEmitter.js";

const TIME_STEP = 1 / 907200; // Delta T
const DRIFT = 0.15; // TODO: Use value from market table, to allow for changing market conditions/**
const DEFAULT_TICKS_TO_AGGREGATE = 10; // Number of ticks to aggregate for OHLC generation, default is 10, which corresponds to 1 candle of 30 seconds, as the stock price is updated every second in the generateStockPrice function. So, 30 ticks will give us 1 minute of OHLC data for each stock.
// const DB_UPDATE_CANDLE_COUNT = 2;`

type Candle = Omit<StockOHLC, "id">;

type LiveStockState = {
	currentCandle: Candle;
	ticksInCurrentCandle: number;
	pendingDbCandles: Candle[];
};

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

const initializeLiveStockState = async (stockId: number) => {
	const result = await sql`
        SELECT open_price, high_price, low_price, close_price, timestamp
        FROM stock_ohlc
        WHERE stock_id = ${stockId}
        ORDER BY timestamp DESC
        LIMIT 1
    `;

	if (result.length === 0) {
		throw new Error(`No OHLC data found for stock ID ${stockId}`);
	}

	const latestCandle = result[0];

	liveStockState.set(stockId, {
		currentCandle: {
			stock_id: stockId,
			open_price: latestCandle.open_price,
			high_price: latestCandle.high_price,
			low_price: latestCandle.low_price,
			close_price: latestCandle.close_price,
			timestamp: latestCandle.timestamp,
		},
		ticksInCurrentCandle: 0,
		pendingDbCandles: [],
	});
};

export const stockSimulator = async (io: Server) => {
	const stocks = await sql`SELECT id, symbol, volatility FROM stocks`;
	
	for (const stock of stocks) {
		const stockId = stock.id;
		const symbol = stock.symbol;
		const volatility = stock.volatility;

		if (!liveStockState.has(stockId)) {
			await initializeLiveStockState(stockId);
		}

		const stockState = liveStockState.get(stockId);
		if (!stockState) {
			console.error(
				`Failed to initialize live stock state for stock ID ${stockId}`,
			);
			continue;
		}

		// Calculate current drift based on active news effects
		let currentDrift = DRIFT;
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

		// Emit the new price to clients
		io.emit("stockPriceUpdate", { ...stockState.currentCandle });
		console.log(
			`Emitted new price for stock ID ${stockState.currentCandle.stock_id}: Open: ${stockState.currentCandle.open_price}, High: ${stockState.currentCandle.high_price}, Low: ${stockState.currentCandle.low_price}, Close: ${stockState.currentCandle.close_price} at ${stockState.currentCandle.timestamp}, ticks in current candle: ${stockState.ticksInCurrentCandle}`,
		);

		// If we've reached the number of ticks to aggregate, prepare to save to DB
		if (isCandleComplete) {
			if (config.ENABLE_STOCK_DB_UPDATES) {
				stockState.pendingDbCandles.push({ ...stockState.currentCandle });

				// Save pending candles to DB
				for (const candle of stockState.pendingDbCandles) {
					await sql`
                        INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
                        VALUES (${candle.stock_id}, ${candle.open_price}, ${candle.high_price}, ${candle.low_price}, ${candle.close_price}, ${candle.timestamp})
                    `;
				}
				stockState.pendingDbCandles = [];
			}
			stockState.ticksInCurrentCandle = 0; // Reset tick count for the next candle
		}
	}
};

