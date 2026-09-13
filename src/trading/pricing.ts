import sql from "../database/database.js";
import { getLivePrice } from "../stockEngine.js";

/**
 * The only place a fill price comes from. Prefers the engine's in-memory tick,
 * then stocks.last_price (the engine's last write, e.g. right after a restart).
 * Never stock_ohlc: it is frozen at seed prices when ENABLE_STOCK_DB_UPDATES is
 * off.
 */
export const getFillPrice = async (
	stockId: number,
): Promise<number | undefined> => {
	const live = getLivePrice(stockId);
	if (live !== undefined) {
		return live;
	}
	const result = await sql`
		SELECT last_price::float8 AS price FROM stocks WHERE id = ${stockId}
	`;
	return (result[0]?.price ?? undefined) as number | undefined;
};
