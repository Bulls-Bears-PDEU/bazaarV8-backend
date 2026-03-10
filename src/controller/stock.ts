import sql from "../database/database.js";
import type Stock from "../models/stock.js";

export const getAllStocks = async () => {
	const result =
		await sql`SELECT id,symbol,name,price,volume,drift,volatility,sector,created_at,locked as "isLocked" FROM stocks`;
	return result as Stock[];
};

export const getStockById = async (id: number) => {
	const result =
		await sql`SELECT id,symbol,name,price,volume,drift,volatility,sector,created_at,locked as "isLocked" FROM stocks WHERE id = ${id}`;
	return result[0] as Stock;
};

export const updateStock = async (id: number, stockData: Partial<Stock>) => {
	const fields = Object.keys(stockData)
		.map((key) => `${key} = ${stockData[key as keyof Stock]}`)
		.join(", ");
	await sql`UPDATE stocks SET ${fields} WHERE id = ${id}`;
};

export const addStock = async (stockData: Omit<Stock, "id" | "created_at">) => {
	const { symbol, name, price, volume, drift, volatility, sector } = stockData;
	await sql`INSERT INTO stocks (symbol, name, price, volume, drift, volatility, sector) VALUES (${symbol}, ${name}, ${price}, ${volume}, ${drift}, ${volatility}, ${sector})`;
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
