import sql from "../database/database.js";
import {
	type FillResult,
	ORDER_ACTIONS,
	type Order,
	type OrderAction,
	type OrderStatus,
	type PlaceOrderInput,
	sideOfAction,
	type TradeLedgerEntry,
} from "../models/order.js";
import { emitToUser } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";
import { addRestingOrder, removeRestingOrder } from "../trading/matcher.js";
import { getFillPrice } from "../trading/pricing.js";

const MAX_PAGE_SIZE = 200;

const toPositiveInt = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const parsePage = (query: Record<string, unknown>) => ({
	limit: Math.min(toPositiveInt(query.limit) ?? 50, MAX_PAGE_SIZE),
	offset: Math.max(Number.parseInt(String(query.offset ?? 0), 10) || 0, 0),
});

/** Validates a placeOrder body; throws INVALID_ORDER with a readable reason. */
export const parsePlaceOrderInput = (body: unknown): PlaceOrderInput => {
	const input = (body ?? {}) as Record<string, unknown>;

	const stockId = toPositiveInt(input.stock_id);
	if (!stockId) {
		throw new TradingError("INVALID_ORDER", "stock_id must be a stock id.");
	}
	// Players send an action. A bare side is still accepted for older callers,
	// and then the position decides what it does, as it always did.
	let action: OrderAction | null = null;
	let side: "buy" | "sell";
	if (input.action !== undefined) {
		if (!ORDER_ACTIONS.includes(input.action as OrderAction)) {
			throw new TradingError(
				"INVALID_ORDER",
				'action must be "buy", "sell", "short" or "cover".',
			);
		}
		action = input.action as OrderAction;
		side = sideOfAction(action);
	} else if (input.side === "buy" || input.side === "sell") {
		side = input.side;
	} else {
		throw new TradingError(
			"INVALID_ORDER",
			'action must be "buy", "sell", "short" or "cover".',
		);
	}
	const orderType = input.order_type ?? "market";
	if (orderType !== "market" && orderType !== "limit") {
		throw new TradingError(
			"INVALID_ORDER",
			'order_type must be "market" or "limit".',
		);
	}
	const quantity = toPositiveInt(input.quantity);
	if (!quantity) {
		throw new TradingError(
			"INVALID_QUANTITY",
			"quantity must be a whole number of shares above zero.",
		);
	}

	let limitPrice: number | undefined;
	if (orderType === "limit") {
		limitPrice = Number(input.limit_price);
		if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
			throw new TradingError(
				"INVALID_ORDER",
				"limit_price must be a price above zero.",
			);
		}
		limitPrice = Math.round(limitPrice * 100) / 100;
	}

	return {
		stock_id: stockId,
		side,
		action,
		order_type: orderType,
		quantity,
		limit_price: limitPrice,
	};
};

/**
 * Fills immediately at the live price. With an action the settlement refuses
 * anything that does not fit the position; without one (older callers) the
 * position decides whether it buys, covers, sells or shorts.
 */
export const placeMarketOrder = async (
	userId: string,
	input: PlaceOrderInput,
): Promise<FillResult> => {
	const price = await getFillPrice(input.stock_id);
	if (price === undefined) {
		throw new TradingError(
			"NO_PRICE",
			"This stock has no price yet. Try again in a moment.",
		);
	}

	const rows = await sql`
		SELECT bazaar_place_market_order(
			${userId}, ${input.stock_id}, ${input.side}, ${input.quantity}, ${price},
			${input.action}
		) AS result
	`;
	const result = rows[0].result as FillResult;

	emitToUser(userId, "orderFilled", result);
	emitWallet(userId, result);
	return result;
};

/** What the limit, modify and release functions return for a resting order. */
export type RestingOrderResult = {
	status: "pending" | "cancelled" | "rejected";
	order_id: number;
	user_id: string;
	stock_id: number;
	side?: "buy" | "sell";
	action?: OrderAction | null;
	quantity?: number;
	limit_price?: number;
	reserved_cash?: number;
	reserved_margin?: number;
	reason?: string | null;
	cash_balance: number;
	frozen_balance: number;
};

const emitWallet = (
	userId: string,
	result: { cash_balance: number; frozen_balance: number },
) => {
	emitToUser(userId, "walletUpdate", {
		cash_balance: result.cash_balance,
		frozen_balance: result.frozen_balance,
	});
};

/**
 * Rests the order, reserving what its fill would need. If it is already
 * marketable it fills immediately at the current price instead.
 */
export const placeLimitOrder = async (
	userId: string,
	input: PlaceOrderInput,
): Promise<FillResult | RestingOrderResult> => {
	// Without a price it simply rests until the first tick crosses it.
	const price = (await getFillPrice(input.stock_id)) ?? null;
	const rows = await sql`
		SELECT bazaar_place_limit_order(
			${userId}, ${input.stock_id}, ${input.side}, ${input.quantity},
			${input.limit_price}, ${price}, ${input.action}
		) AS result
	`;
	const result = rows[0].result as FillResult | RestingOrderResult;

	if (result.status === "filled") {
		emitToUser(userId, "orderFilled", result);
	} else {
		addRestingOrder({
			id: result.order_id,
			userId,
			stockId: input.stock_id,
			side: input.side,
			limitPrice: result.limit_price as number,
		});
		emitToUser(userId, "orderPlaced", result);
	}
	emitWallet(userId, result);
	return result;
};

/**
 * Race-safe against a fill: if the matcher filled it first this throws
 * ORDER_NOT_PENDING (409) and the client should refetch the order.
 */
export const cancelOrder = async (userId: string, orderId: number) => {
	const rows = await sql`
		SELECT bazaar_release_order(${orderId}, ${userId}, 'cancelled', NULL) AS result
	`;
	const result = rows[0].result as RestingOrderResult;
	removeRestingOrder(orderId);
	emitToUser(userId, "orderCancelled", result);
	emitWallet(userId, result);
	return result;
};

export const modifyOrder = async (
	userId: string,
	orderId: number,
	changes: { quantity?: number; limit_price?: number },
) => {
	const rows = await sql`
		SELECT bazaar_modify_order(
			${orderId}, ${userId}, ${changes.quantity ?? null}, ${changes.limit_price ?? null}
		) AS result
	`;
	const result = rows[0].result as RestingOrderResult;
	addRestingOrder({
		id: result.order_id,
		userId,
		stockId: result.stock_id,
		side: result.side as "buy" | "sell",
		limitPrice: result.limit_price as number,
	});
	emitToUser(userId, "orderModified", result);
	emitWallet(userId, result);
	return result;
};

// NUMERIC columns are cast to float8 so the driver returns numbers.
const ORDER_COLUMNS = sql`
	o.id::int AS id, o.user_id, o.stock_id, s.symbol, s.name,
	o.side, o.action, o.order_type, o.quantity, o.filled_quantity,
	o.limit_price::float8 AS limit_price,
	o.average_fill_price::float8 AS average_fill_price,
	o.reserved_cash::float8 AS reserved_cash,
	o.reserved_margin::float8 AS reserved_margin,
	-- What the order holds back from cash in total, for display.
	(o.reserved_cash + o.reserved_margin)::float8 AS reserved_total,
	o.status, o.reject_reason,
	o.created_at, o.updated_at, o.filled_at, o.cancelled_at
`;

export const getOpenOrders = async (userId: string, stockId?: number) => {
	const rows = await sql`
		SELECT ${ORDER_COLUMNS}
		FROM orders o JOIN stocks s ON s.id = o.stock_id
		WHERE o.user_id = ${userId}
			AND o.status = 'pending'
			AND (${stockId ?? null}::int IS NULL OR o.stock_id = ${stockId ?? null}::int)
		ORDER BY o.created_at DESC
	`;
	return rows as Order[];
};

export const getOrderHistory = async (
	userId: string,
	filters: {
		limit: number;
		offset: number;
		stockId?: number;
		status?: OrderStatus;
	},
) => {
	const stockId = filters.stockId ?? null;
	const status = filters.status ?? null;
	const [rows, count] = await Promise.all([
		sql`
			SELECT ${ORDER_COLUMNS}
			FROM orders o JOIN stocks s ON s.id = o.stock_id
			WHERE o.user_id = ${userId}
				AND (${stockId}::int IS NULL OR o.stock_id = ${stockId}::int)
				AND (${status}::text IS NULL OR o.status = ${status}::text)
			ORDER BY o.created_at DESC
			LIMIT ${filters.limit} OFFSET ${filters.offset}
		`,
		sql`
			SELECT count(*)::int AS total FROM orders o
			WHERE o.user_id = ${userId}
				AND (${stockId}::int IS NULL OR o.stock_id = ${stockId}::int)
				AND (${status}::text IS NULL OR o.status = ${status}::text)
		`,
	]);
	return { orders: rows as Order[], total: count[0].total as number };
};

export const getOrderById = async (userId: string, orderId: number) => {
	const rows = await sql`
		SELECT ${ORDER_COLUMNS}
		FROM orders o JOIN stocks s ON s.id = o.stock_id
		WHERE o.id = ${orderId} AND o.user_id = ${userId}
	`;
	return rows[0] as Order | undefined;
};

export const getTradeLedger = async (
	userId: string,
	filters: { limit: number; offset: number; stockId?: number },
) => {
	const stockId = filters.stockId ?? null;
	const [rows, count] = await Promise.all([
		sql`
			SELECT
				t.id, t.order_id::int AS order_id, t.stock_id, s.symbol, s.name,
				t.transaction_type, t.volume,
				t.price::float8 AS price,
				(t.price * t.volume)::float8 AS value,
				t.realized_pnl::float8 AS realized_pnl,
				t.timestamp
			FROM user_stock_transactions t JOIN stocks s ON s.id = t.stock_id
			WHERE t.user_id = ${userId}
				AND (${stockId}::int IS NULL OR t.stock_id = ${stockId}::int)
			ORDER BY t.timestamp DESC, t.id DESC
			LIMIT ${filters.limit} OFFSET ${filters.offset}
		`,
		sql`
			SELECT count(*)::int AS total FROM user_stock_transactions t
			WHERE t.user_id = ${userId}
				AND (${stockId}::int IS NULL OR t.stock_id = ${stockId}::int)
		`,
	]);
	return { trades: rows as TradeLedgerEntry[], total: count[0].total as number };
};
