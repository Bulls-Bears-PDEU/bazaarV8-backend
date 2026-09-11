import sql from "../database/database.js";
import eventEmitter from "../eventEmitter.js";
import type { Stock, StockOHLC } from "../models/stock.js";

// Tells the stock engine to reload its cached stock list.
const notifyStocksChanged = () => {
	eventEmitter.emit("stocksChanged");
};

export const getAllStocks = async () => {
	const result = await sql`SELECT * FROM stocks`;
	return result as Stock[];
};

/**
 * Prices come from stocks.last_price, which the engine writes every tick.
 * stock_ohlc is only the fallback: with ENABLE_STOCK_DB_UPDATES off it is
 * frozen at seed prices, so reading it would report prices that stopped moving.
 */
export const getCurrentPricesForAllStocks = async () => {
	const result = await sql`
		SELECT
			s.id AS stock_id,
			COALESCE(s.last_price, latest.close_price)::float8 AS current_price
		FROM stocks s
		LEFT JOIN LATERAL (
			SELECT close_price
			FROM stock_ohlc
			WHERE stock_id = s.id
			ORDER BY timestamp DESC
			LIMIT 1
		) latest ON TRUE
	`;
	const currentPrices: Record<number, number> = {};
	for (const row of result) {
		if (row.current_price !== null) {
			currentPrices[row.stock_id] = row.current_price as number;
		}
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
	const result = await sql`
		SELECT COALESCE(
			s.last_price,
			(SELECT close_price FROM stock_ohlc WHERE stock_id = s.id ORDER BY timestamp DESC LIMIT 1)
		)::float8 AS price
		FROM stocks s
		WHERE s.id = ${stockId}
	`;
	return (result[0]?.price ?? undefined) as number | undefined;
};

export const updateStock = async (
	id: number,
	// `isLocked` is accepted for older admin clients; `locked` is the field name.
	stockData: Partial<Stock> & { isLocked?: boolean },
) => {
	const locked = stockData.locked ?? stockData.isLocked;
	const hasUpdates =
		stockData.symbol !== undefined ||
		stockData.name !== undefined ||
		stockData.volatility !== undefined ||
		stockData.sector !== undefined ||
		locked !== undefined;

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
			locked = COALESCE(${locked ?? null}, locked)
		WHERE id = ${id}
	`;
	notifyStocksChanged();
};

export const addStock = async (
	stockData: Pick<Stock, "symbol" | "name" | "volatility" | "sector">,
	initPrice: number,
) => {
	const { symbol, name, volatility, sector } = stockData;
	const result = await sql`
		INSERT INTO stocks (symbol, name, volatility, sector, last_price, last_price_at)
		VALUES (${symbol}, ${name}, ${volatility}, ${sector}, ${initPrice}, CURRENT_TIMESTAMP)
		RETURNING id
	`;
	const stockId = result[0].id;
	const timestamp = new Date().toISOString();
	await sql`
			INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
			VALUES (${stockId}, ${initPrice}, ${initPrice}, ${initPrice}, ${initPrice}, ${timestamp})
		`;
	notifyStocksChanged();
};

export const addStockOHLC = async (stockId: number, ohlcData: StockOHLC) => {
	const { open_price, high_price, low_price, close_price, timestamp } =
		ohlcData;
	await sql`
			INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
			VALUES (${stockId}, ${open_price}, ${high_price}, ${low_price}, ${close_price}, ${timestamp})
		`;
};

/** Matches a symbol prefix ("STK1") or words in the company name. */
export const searchStocks = async (query: string) => {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}
	const result = await sql`
		SELECT * FROM stocks
		WHERE symbol ILIKE ${`${trimmed}%`}
			OR name_tsv @@ plainto_tsquery('english', ${trimmed})
		ORDER BY (symbol ILIKE ${`${trimmed}%`}) DESC, symbol
		LIMIT 50
	`;
	return result as Stock[];
};

export const getAllSectors = async () => {
	const result = await sql`SELECT DISTINCT sector FROM stocks`;
	return result.map((row) => row.sector);
};

/**
 * Same shape as getCurrentPricesForAllStocks, for a subset of stocks. The old
 * version had no DISTINCT ON and returned every candle for every stock asked
 * for, instead of one price each.
 */
export const getCurrentPriceForStocks = async (stockIds: number[]) => {
	if (stockIds.length === 0) {
		return {};
	}
	const result = await sql`
		SELECT
			s.id AS stock_id,
			COALESCE(s.last_price, latest.close_price)::float8 AS current_price
		FROM stocks s
		LEFT JOIN LATERAL (
			SELECT close_price
			FROM stock_ohlc
			WHERE stock_id = s.id
			ORDER BY timestamp DESC
			LIMIT 1
		) latest ON TRUE
		WHERE s.id = ANY(${stockIds}::int[])
	`;
	const currentPrices: Record<number, number> = {};
	for (const row of result) {
		if (row.current_price !== null) {
			currentPrices[row.stock_id] = row.current_price as number;
		}
	}
	return currentPrices;
};

export const deleteStock = async (id: number) => {
	await sql`DELETE FROM stocks WHERE id = ${id}`;
	notifyStocksChanged();
};

export const lockStock = async (id: number) => {
	await sql`UPDATE stocks SET locked = true WHERE id = ${id}`;
	notifyStocksChanged();
};

export const unlockStock = async (id: number) => {
	await sql`UPDATE stocks SET locked = false WHERE id = ${id}`;
	notifyStocksChanged();
};
