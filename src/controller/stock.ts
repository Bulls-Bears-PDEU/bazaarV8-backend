import sql from "../database/database.js";
import type { Stock, StockOHLC } from "../models/stock.js";

export const getAllStocks = async () => {
	const result = await sql`SELECT * FROM stocks`;
	return result as Stock[];
};

export const getStockById = async (id: number) => {
	const result = await sql`SELECT * FROM stocks WHERE id = ${id}`;
	return result[0] as Stock;
};

export const getOHLCByStockId = async (stockId: number) => {
	const result =
		await sql`SELECT * FROM stock_ohlc WHERE stock_id = ${stockId} ORDER BY timestamp DESC`;
	return result as StockOHLC[];
};

export const getCurrentPrice = async (stockId: number) => {
	const result =
		await sql`SELECT close_price FROM stock_ohlc WHERE stock_id = ${stockId} ORDER BY timestamp DESC LIMIT 1`;
	return result[0]?.close_price as number | undefined;
};

export const updateStock = async (
	id: number,
	stockData: Partial<Stock>,
	stockOHLCData: StockOHLC[],
) => {
	const fields = Object.keys(stockData)
		.map((key) => `${key} = ${stockData[key as keyof Stock]}`)
		.join(", ");
	await sql`UPDATE stocks SET ${fields} WHERE id = ${id}`;
	await sql`DELETE FROM stock_ohlc WHERE stock_id = ${id}`;
	for (const ohlc of stockOHLCData) {
		const { open_price, high_price, low_price, close_price, timestamp } = ohlc;
		await sql`
			INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
			VALUES (${id}, ${open_price}, ${high_price}, ${low_price}, ${close_price}, ${timestamp})
		`;
	}
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