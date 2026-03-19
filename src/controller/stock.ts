import sql from "../database/database.js";
import type { Stock, StockOHLC } from "../models/stock.js";

export const getAllStocks = async () => {
	const result = await sql`SELECT * FROM stocks`;
	return result as Stock[];
};

export const getCurrentPricesForAllStocks = async () => {
	const result = await sql`
		SELECT DISTINCT ON (stock_id)
			stock_id,
		    close_price AS current_price
		FROM Stock_OHLC
		ORDER BY stock_id, timestamp DESC;
	`;
	console.log("Current prices for all stocks:", result);
	// Transform the result into an Map with stock_id as key and current_price as value
	const currentPrices: Record<number, number> = {};
	for (const row of result) {
		currentPrices[row.stock_id] = row.current_price as number;
	}
	return currentPrices;
};

export const getStockById = async (id: number) => {
	const result = await sql`SELECT * FROM stocks WHERE id = ${id}`;
	return result[0] as Stock;
};

export const getOHLCByStockId = async (stockId: number) => {
	const result =
		await sql`SELECT * FROM stock_ohlc WHERE stock_id = ${stockId} ORDER BY timestamp ASC`;
	return result as StockOHLC[];
};

export const getCurrentPrice = async (stockId: number) => {
	const result =
		await sql`SELECT close_price FROM stock_ohlc WHERE stock_id = ${stockId} ORDER BY timestamp DESC LIMIT 1`;
	return result[0]?.close_price as number | undefined;
};

export const updateStock = async (id: number, stockData: Partial<Stock>) => {
	const hasUpdates =
		stockData.symbol !== undefined ||
		stockData.name !== undefined ||
		stockData.volatility !== undefined ||
		stockData.sector !== undefined ||
		stockData.isLocked !== undefined;

	if (!hasUpdates) {
		return;
	}

	await sql`
		UPDATE stocks
		SET
			symbol = COALESCE(${stockData.symbol ?? null}, symbol),
			name = COALESCE(${stockData.name ?? null}, name),
			volatility = COALESCE(${stockData.volatility ?? null}, volatility),
			sector = COALESCE(${stockData.sector ?? null}, sector),
			locked = COALESCE(${stockData.isLocked ?? null}, locked)
		WHERE id = ${id}
	`;
};

export const addStock = async (
	stockData: Omit<Stock, "id" | "created_at">,
	initPrice: number,
) => {
	const { symbol, name, volatility, sector } = stockData;
	await sql`INSERT INTO stocks (symbol, name, volatility, sector) VALUES (${symbol}, ${name}, ${volatility}, ${sector})`;
	const result = await sql`SELECT id FROM stocks WHERE symbol = ${symbol}`;
	const stockId = result[0].id;
	const timestamp = new Date().toISOString();
	await sql`
			INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
			VALUES (${stockId}, ${initPrice}, ${initPrice}, ${initPrice}, ${initPrice}, ${timestamp})
		`;
};

export const addStockOHLC = async (stockId: number, ohlcData: StockOHLC) => {
	const { open_price, high_price, low_price, close_price, timestamp } =
		ohlcData;
	await sql`
			INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
			VALUES (${stockId}, ${open_price}, ${high_price}, ${low_price}, ${close_price}, ${timestamp})
		`;
};

export const searchStocks = async (query: string) => {
	const result = await sql`
		SELECT * FROM stocks WHERE name_tsv @@ plainto_tsquery('english', ${query})
	`;
	return result;
};

export const getAllSectors = async () => {
	const result = await sql`SELECT DISTINCT sector FROM stocks`;
	return result.map((row) => row.sector);
};

export const getCurrentPriceForStocks = async (stockIds: number[]) => {
	const result = await sql`
		SELECT stock_id, close_price FROM stock_ohlc
		WHERE stock_id = ANY(${stockIds})
		ORDER BY stock_id, timestamp DESC
	`;
	return result;
};

export const deleteStock = async (id: number) => {
	await sql`DELETE FROM stocks WHERE id = ${id}`;
};

export const lockStock = async (id: number) => {
	await sql`UPDATE stocks SET locked = true WHERE id = ${id}`;
};

export const unlockStock = async (id: number) => {
	await sql`UPDATE stocks SET locked = false WHERE id = ${id}`;
};

// TODO: Figure out a way to push OHLC data update to db in a separate thread so when cron job pushes new OHLC data every 10 secs it doesn't block the main thread and cause performance issues. Maybe use worker threads or a message queue like RabbitMQ or Redis to handle the OHLC data updates asynchronously.