import sql from "../database/database.js";
import type { FillResult, OrderSide } from "../models/order.js";
import { emitToUser } from "../realtime/emitter.js";
import { toTradingError, type TradingErrorCode } from "./errors.js";

/**
 * Resting limit orders, held in memory so the tick loop can check them for free.
 *
 * The book is advisory: it decides when to try a fill, never whether one is
 * allowed. bazaar_execute_fill only fills an order that is still pending, so a
 * fill racing a cancel resolves in the database, exactly one wins, and the book
 * is corrected from the outcome.
 *
 * Per stock, buys are sorted by limit descending and sells ascending, so the
 * orders that can fill are always at the front and a tick stops at the first
 * one that cannot: the cost is proportional to fills, not to resting orders.
 *
 * Single-process only, like the engine's own state: a second backend process
 * would hold a second book.
 */
type RestingOrder = {
	id: number;
	userId: string;
	stockId: number;
	side: OrderSide;
	limitPrice: number;
};

type StockBook = { buys: RestingOrder[]; sells: RestingOrder[] };

const books = new Map<number, StockBook>();
const byId = new Map<number, RestingOrder>();
// Orders handed to the drain and not yet resolved, so later ticks do not
// queue them twice.
const queued = new Set<number>();

const bookFor = (stockId: number): StockBook => {
	let book = books.get(stockId);
	if (!book) {
		book = { buys: [], sells: [] };
		books.set(stockId, book);
	}
	return book;
};

// Buys best (highest) first, sells best (lowest) first; ties by age via id.
const ranksBefore = (a: RestingOrder, b: RestingOrder) =>
	a.side === "buy"
		? a.limitPrice > b.limitPrice ||
			(a.limitPrice === b.limitPrice && a.id < b.id)
		: a.limitPrice < b.limitPrice ||
			(a.limitPrice === b.limitPrice && a.id < b.id);

export const addRestingOrder = (order: RestingOrder) => {
	removeRestingOrder(order.id);
	const book = bookFor(order.stockId);
	const side = order.side === "buy" ? book.buys : book.sells;
	let index = side.findIndex((existing) => ranksBefore(order, existing));
	if (index === -1) index = side.length;
	side.splice(index, 0, order);
	byId.set(order.id, order);
};

export const removeRestingOrder = (orderId: number) => {
	const order = byId.get(orderId);
	if (!order) return;
	byId.delete(orderId);
	queued.delete(orderId);
	const book = books.get(order.stockId);
	if (!book) return;
	const side = order.side === "buy" ? book.buys : book.sells;
	const index = side.findIndex((existing) => existing.id === orderId);
	if (index !== -1) side.splice(index, 1);
};

/** Rebuilds the book from the database. Called once at boot. */
export const loadRestingOrders = async () => {
	const rows = await sql`
		SELECT id::int AS id, user_id, stock_id, side, limit_price::float8 AS limit_price
		FROM orders
		WHERE status = 'pending' AND order_type = 'limit'
	`;
	books.clear();
	byId.clear();
	queued.clear();
	for (const row of rows) {
		addRestingOrder({
			id: row.id,
			userId: row.user_id,
			stockId: row.stock_id,
			side: row.side,
			limitPrice: row.limit_price,
		});
	}
	console.info(`Loaded ${rows.length} resting limit orders.`);
};

/**
 * Called by the engine after every tick with each stock's latest price. Pure
 * in-memory; queues crossing orders for the drain and returns immediately.
 */
export const matchTick = (
	prices: { stock_id: number; close_price: number }[],
) => {
	for (const { stock_id: stockId, close_price: price } of prices) {
		const book = books.get(stockId);
		if (!book) continue;
		for (const order of book.buys) {
			if (order.limitPrice < price) break;
			queued.add(order.id);
		}
		for (const order of book.sells) {
			if (order.limitPrice > price) break;
			queued.add(order.id);
		}
	}
};

// Stay pending and retry on a later crossing.
const RETRYABLE: TradingErrorCode[] = [
	"MARKET_PAUSED",
	"STOCK_LOCKED",
	"NO_PRICE",
	"INTERNAL_ERROR",
];
// Already filled or cancelled elsewhere: just forget it.
const GONE: TradingErrorCode[] = ["ORDER_NOT_PENDING", "ORDER_NOT_FOUND"];

const fillOne = async (order: RestingOrder) => {
	try {
		// Resting orders fill at their limit, so the reservation (sized at the
		// limit) always covers the fill exactly.
		const rows = await sql`
			SELECT bazaar_execute_fill(${order.id}, ${order.limitPrice}) AS result
		`;
		const result = rows[0].result as FillResult;
		removeRestingOrder(order.id);
		emitToUser(order.userId, "orderFilled", result);
		emitToUser(order.userId, "walletUpdate", {
			cash_balance: result.cash_balance,
			frozen_balance: result.frozen_balance,
		});
	} catch (error) {
		const { code, message } = toTradingError(error);
		if (GONE.includes(code)) {
			removeRestingOrder(order.id);
			return;
		}
		if (RETRYABLE.includes(code)) {
			queued.delete(order.id);
			return;
		}
		// The position or balance changed since the order was placed (for example
		// the long it was selling was sold, so it would now open a short the
		// player cannot margin). Reject it and give the reservation back.
		await rejectOrder(order, message);
	}
};

const rejectOrder = async (order: RestingOrder, reason: string) => {
	try {
		const rows = await sql`
			SELECT bazaar_release_order(${order.id}, NULL, 'rejected', ${reason}) AS result
		`;
		const result = rows[0].result;
		emitToUser(order.userId, "orderRejected", result);
		emitToUser(order.userId, "walletUpdate", {
			cash_balance: result.cash_balance,
			frozen_balance: result.frozen_balance,
		});
	} catch (error) {
		// Most likely it was cancelled meanwhile; the database is the authority.
		console.error(`Could not reject order ${order.id}:`, error);
	}
	removeRestingOrder(order.id);
};

// Different users' fills are independent; one user's are serialised by the
// user row lock inside the fill.
const DRAIN_CONCURRENCY = 8;
let isDraining = false;

/** Settles every queued crossing. Runs on its own interval, off the tick path. */
export const drainQueuedFills = async () => {
	if (isDraining || queued.size === 0) return;
	isDraining = true;
	try {
		const pending = [...queued]
			.map((id) => byId.get(id))
			.filter((order): order is RestingOrder => order !== undefined);
		for (let i = 0; i < pending.length; i += DRAIN_CONCURRENCY) {
			await Promise.all(pending.slice(i, i + DRAIN_CONCURRENCY).map(fillOne));
		}
	} finally {
		isDraining = false;
	}
};
