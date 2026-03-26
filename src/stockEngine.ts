/**
 * This file contains the logic for the stock generation engine, which makes realtime stock prices on the fly using a GBM model. The GBM model is a stochastic process that is commonly used to model stock prices. More info on the working of the model can be found in the stockEngine.md file in the docs folder.
 */

import type { StockOHLC } from "./models/stock.js";

const TIME_STEP = 1 / 907200; // Delta T
const DRIFT = 0.15; // TODO: Use value from market table, to allow for changing market conditions/**
const DEFAULT_TICKS_TO_AGGREGATE = 30; // Number of ticks to aggregate for OHLC generation, default is 30, which corresponds to 1 candle of 30 seconds, as the stock price is updated every second in the generateStockPrice function. So, 30 ticks will give us 1 minute of OHLC data for each stock.

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
 */
export const generateStockPrice = (
	candleStick: Omit<StockOHLC, "id">,
	volatility: number,
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
				(DRIFT - 0.5 * volatility ** 2) * TIME_STEP +
					volatility * z * Math.sqrt(TIME_STEP),
			);

		highPrice = Math.max(highPrice, closePrice);
		lowPrice = Math.min(lowPrice, closePrice);
	}

	return {
		stock_id: candleStick.stock_id,
		open_price: openPrice,
		high_price: highPrice,
		low_price: lowPrice,
		close_price: closePrice,
		timestamp: new Date(
			new Date(candleStick.timestamp).getTime() + noOfTicks * 1000,
		).toISOString(),
	};
};
