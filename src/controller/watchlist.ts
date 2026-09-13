import sql from "../database/database.js";
import { pgErrorCode, TradingError } from "../trading/errors.js";

const MAX_WATCHLISTS = 10;
const MAX_ITEMS_PER_WATCHLIST = 50;
const DEFAULT_WATCHLIST_NAME = "My Watchlist";

export type WatchlistItem = {
	stock_id: number;
	symbol: string;
	name: string;
	sector: string;
	locked: boolean;
	last_price: number | null;
	position: number;
};

export type Watchlist = {
	id: number;
	name: string;
	position: number;
	items: WatchlistItem[];
};

const notFound = () =>
	new TradingError("WATCHLIST_NOT_FOUND", "Watchlist not found.");

const duplicateName = (name: string) =>
	new TradingError(
		"DUPLICATE_NAME",
		`You already have a watchlist called "${name}".`,
	);

export const parseWatchlistName = (value: unknown): string => {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name || name.length > 60) {
		throw new TradingError(
			"INVALID_INPUT",
			"Watchlist names must be 1 to 60 characters.",
		);
	}
	return name;
};

/**
 * Every watchlist with its stocks, in display order. A player with none gets a
 * default one, so the UI always has somewhere to add a stock.
 */
export const getWatchlists = async (userId: string): Promise<Watchlist[]> => {
	let lists = await sql`
		SELECT id, name, position FROM watchlists
		WHERE user_id = ${userId} ORDER BY position, id
	`;
	if (lists.length === 0) {
		// DO NOTHING covers two first loads racing to create it.
		await sql`
			INSERT INTO watchlists (user_id, name) VALUES (${userId}, ${DEFAULT_WATCHLIST_NAME})
			ON CONFLICT DO NOTHING
		`;
		lists = await sql`
			SELECT id, name, position FROM watchlists
			WHERE user_id = ${userId} ORDER BY position, id
		`;
	}

	const items = await sql`
		SELECT
			wi.watchlist_id, wi.stock_id, wi.position,
			s.symbol, s.name, s.sector, s.locked,
			s.last_price::float8 AS last_price
		FROM watchlist_items wi
		JOIN watchlists w ON w.id = wi.watchlist_id
		JOIN stocks s ON s.id = wi.stock_id
		WHERE w.user_id = ${userId}
		ORDER BY wi.position, wi.id
	`;

	return lists.map((list) => ({
		id: list.id,
		name: list.name,
		position: list.position,
		items: items
			.filter((item) => item.watchlist_id === list.id)
			.map(({ watchlist_id: _, ...item }) => item as WatchlistItem),
	}));
};

export const createWatchlist = async (userId: string, name: string) => {
	const [{ count }] = await sql`
		SELECT count(*)::int AS count FROM watchlists WHERE user_id = ${userId}
	`;
	if (count >= MAX_WATCHLISTS) {
		throw new TradingError(
			"LIMIT_REACHED",
			`You can have at most ${MAX_WATCHLISTS} watchlists.`,
		);
	}
	try {
		const rows = await sql`
			INSERT INTO watchlists (user_id, name, position)
			VALUES (
				${userId}, ${name},
				(SELECT COALESCE(MAX(position), -1) + 1 FROM watchlists WHERE user_id = ${userId})
			)
			RETURNING id, name, position
		`;
		const created: Watchlist = {
			...(rows[0] as Omit<Watchlist, "items">),
			items: [],
		};
		return created;
	} catch (error) {
		if (pgErrorCode(error) === "23505") throw duplicateName(name);
		throw error;
	}
};

export const renameWatchlist = async (
	userId: string,
	watchlistId: number,
	name: string,
) => {
	try {
		const rows = await sql`
			UPDATE watchlists SET name = ${name}, updated_at = CURRENT_TIMESTAMP
			WHERE id = ${watchlistId} AND user_id = ${userId}
			RETURNING id, name, position
		`;
		if (rows.length === 0) throw notFound();
		return rows[0];
	} catch (error) {
		if (pgErrorCode(error) === "23505") throw duplicateName(name);
		throw error;
	}
};

export const deleteWatchlist = async (userId: string, watchlistId: number) => {
	const rows = await sql`
		DELETE FROM watchlists WHERE id = ${watchlistId} AND user_id = ${userId}
		RETURNING id
	`;
	if (rows.length === 0) throw notFound();
};

const assertOwnWatchlist = async (userId: string, watchlistId: number) => {
	const rows = await sql`
		SELECT id FROM watchlists WHERE id = ${watchlistId} AND user_id = ${userId}
	`;
	if (rows.length === 0) throw notFound();
};

/** Adding a stock that is already on the list is a no-op, not an error. */
export const addWatchlistItem = async (
	userId: string,
	watchlistId: number,
	stockId: number,
) => {
	await assertOwnWatchlist(userId, watchlistId);
	const [{ count }] = await sql`
		SELECT count(*)::int AS count FROM watchlist_items WHERE watchlist_id = ${watchlistId}
	`;
	if (count >= MAX_ITEMS_PER_WATCHLIST) {
		throw new TradingError(
			"LIMIT_REACHED",
			`A watchlist can hold at most ${MAX_ITEMS_PER_WATCHLIST} stocks.`,
		);
	}
	try {
		await sql`
			INSERT INTO watchlist_items (watchlist_id, stock_id, position)
			VALUES (
				${watchlistId}, ${stockId},
				(SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist_items WHERE watchlist_id = ${watchlistId})
			)
			ON CONFLICT (watchlist_id, stock_id) DO NOTHING
		`;
	} catch (error) {
		if (pgErrorCode(error) === "23503") {
			throw new TradingError("STOCK_NOT_FOUND", "Stock not found.");
		}
		throw error;
	}
};

export const removeWatchlistItem = async (
	userId: string,
	watchlistId: number,
	stockId: number,
) => {
	await assertOwnWatchlist(userId, watchlistId);
	await sql`
		DELETE FROM watchlist_items
		WHERE watchlist_id = ${watchlistId} AND stock_id = ${stockId}
	`;
};

/** Sets the order to exactly the given stock ids; ids not on the list are ignored. */
export const reorderWatchlistItems = async (
	userId: string,
	watchlistId: number,
	stockIds: number[],
) => {
	await assertOwnWatchlist(userId, watchlistId);
	await sql`
		UPDATE watchlist_items wi
		SET position = t.ord
		FROM UNNEST(${stockIds}::int[]) WITH ORDINALITY AS t(stock_id, ord)
		WHERE wi.watchlist_id = ${watchlistId} AND wi.stock_id = t.stock_id
	`;
};
