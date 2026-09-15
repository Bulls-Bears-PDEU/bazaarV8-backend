/**
 * What an order or an IPO application would do, before the player commits.
 *
 * A preview runs the real settlement function inside a transaction and rolls
 * it back, so it can never disagree with what placing the order does: the same
 * fill legs, cash, margin, realised P&L and refusals, with nothing kept. The
 * rules live once, in the database functions.
 */

import { getMarketState } from "../controller/market.js";
import sql from "../database/database.js";
import { type PoolClient, pool } from "../database/pool.js";
import { type Fill, type OrderAction, ORDER_ACTIONS, type OrderType, sideOfAction } from "../models/order.js";
import { toTradingError, TradingError, type TradingErrorCode } from "./errors.js";
import { getFillPrice } from "./pricing.js";

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Runs fn in a transaction that is always rolled back. */
const dryRun = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		return await fn(client);
	} finally {
		await client.query("ROLLBACK").catch(() => {});
		client.release();
	}
};

type PositionSummary = {
	side: "long" | "short";
	quantity: number;
	average_price: number;
	margin_locked: number;
};

const summarise = (volume: number, averagePrice: number, marginLocked: number): PositionSummary | null =>
	volume === 0
		? null
		: {
				side: volume > 0 ? "long" : "short",
				quantity: Math.abs(volume),
				average_price: averagePrice,
				margin_locked: marginLocked,
			};

export type ActionAvailability = {
	available: boolean;
	// The most shares this action can take now; 0 when unavailable.
	max_quantity: number;
	// Shares of the position already promised to open sell or cover orders.
	committed: number;
	// Why it is unavailable, in the player's words.
	reason: string | null;
};

export type TradeContext = {
	stock_id: number;
	// The market price, or the limit price when sizing a limit order.
	price: number | null;
	market_price: number | null;
	market_paused: boolean;
	stock_locked: boolean;
	cash_balance: number;
	short_margin_pct: number;
	allow_short_selling: boolean;
	allow_limit_orders: boolean;
	max_order_quantity: number;
	position: PositionSummary | null;
	actions: Record<OrderAction, ActionAvailability>;
};

/**
 * The player's position in one stock and what each of Buy, Sell, Short and
 * Cover can do with it right now. Mirrors the refusals in bazaar_check_action
 * and bazaar_validate_action, which remain the authority when an order is
 * placed.
 */
export const getTradeContext = async (
	userId: string,
	stockId: number,
	limitPrice?: number,
): Promise<TradeContext> => {
	const [market, marketPrice, stockRows, userRows, positionRows, committedRows] = await Promise.all([
		getMarketState(),
		getFillPrice(stockId),
		sql`SELECT locked FROM stocks WHERE id = ${stockId}`,
		sql`SELECT cash_balance::float8 AS cash_balance FROM users WHERE id = ${userId}`,
		sql`
			SELECT volume, average_price::float8 AS average_price, margin_locked::float8 AS margin_locked
			FROM user_portfolios WHERE user_id = ${userId} AND stock_id = ${stockId}
		`,
		sql`
			SELECT action, COALESCE(SUM(quantity - filled_quantity), 0)::int AS quantity
			FROM orders
			WHERE user_id = ${userId} AND stock_id = ${stockId} AND status = 'pending' AND action IS NOT NULL
			GROUP BY action
		`,
	]);
	if (stockRows.length === 0) {
		throw new TradingError("STOCK_NOT_FOUND", "Stock not found.");
	}

	const volume = Number(positionRows[0]?.volume ?? 0);
	const averagePrice = Number(positionRows[0]?.average_price ?? 0);
	const marginLocked = Number(positionRows[0]?.margin_locked ?? 0);
	const cash = Number(userRows[0]?.cash_balance ?? 0);
	const committedBy = new Map(committedRows.map((row) => [String(row.action), Number(row.quantity)]));
	const locked = Boolean(stockRows[0].locked);
	const price = limitPrice ?? marketPrice ?? null;
	const cap = (quantity: number) => Math.max(0, Math.min(Math.floor(quantity), market.max_order_quantity));

	// Refusals that apply to every action.
	const blocked = market.is_paused
		? "The market is paused."
		: locked
			? "Trading in this stock is halted."
			: price === null
				? "This stock has no price yet."
				: null;

	const availability = (action: OrderAction): ActionAvailability => {
		const committed = action === "sell" || action === "cover" ? (committedBy.get(action) ?? 0) : 0;
		const unavailable = (reason: string): ActionAvailability => ({
			available: false,
			max_quantity: 0,
			committed,
			reason,
		});
		if (blocked) return unavailable(blocked);
		const sizing = price as number;

		switch (action) {
			case "buy": {
				if (volume < 0) return unavailable(`You are short ${-volume} shares. Cover them before buying.`);
				const max = cap(cash / sizing);
				return max > 0
					? { available: true, max_quantity: max, committed, reason: null }
					: unavailable("You do not have enough cash for one share.");
			}
			case "sell": {
				if (volume < 0) return unavailable("You are short this stock. Use Cover to close a short.");
				if (volume === 0) return unavailable("You hold no shares of this stock to sell.");
				const max = cap(volume - committed);
				return max > 0
					? { available: true, max_quantity: max, committed, reason: null }
					: unavailable(`All ${volume} of your shares are already in open sell orders.`);
			}
			case "short": {
				if (volume > 0) return unavailable(`You hold ${volume} shares. Sell them before shorting.`);
				if (!market.allow_short_selling) return unavailable("Short selling is turned off.");
				const max = cap(cash / ((sizing * market.short_margin_pct) / 100));
				return max > 0
					? { available: true, max_quantity: max, committed, reason: null }
					: unavailable("You do not have enough cash for the margin on one share.");
			}
			case "cover": {
				if (volume > 0) return unavailable("You hold this stock. Use Sell to close a long.");
				if (volume === 0) return unavailable("You have no short in this stock to cover.");
				const max = cap(-volume - committed);
				return max > 0
					? { available: true, max_quantity: max, committed, reason: null }
					: unavailable(`All ${-volume} shares of your short are already in open cover orders.`);
			}
		}
	};

	return {
		stock_id: stockId,
		price,
		market_price: marketPrice ?? null,
		market_paused: market.is_paused,
		stock_locked: locked,
		cash_balance: cash,
		short_margin_pct: market.short_margin_pct,
		allow_short_selling: market.allow_short_selling,
		allow_limit_orders: market.allow_limit_orders,
		max_order_quantity: market.max_order_quantity,
		position: summarise(volume, averagePrice, marginLocked),
		actions: Object.fromEntries(ORDER_ACTIONS.map((action) => [action, availability(action)])) as Record<
			OrderAction,
			ActionAvailability
		>,
	};
};

export type OrderPreviewInput = {
	stock_id: number;
	action: OrderAction;
	order_type: OrderType;
	quantity: number;
	limit_price?: number;
};

export type OrderPreview =
	| {
			ok: true;
			// "filled": it would fill now. "pending": a limit order that would rest.
			status: "filled" | "pending";
			action: OrderAction;
			quantity: number;
			// The fill price, or the limit price for a resting order.
			price: number;
			legs: Fill[];
			realized_pnl: number;
			margin_locked: number;
			// What a resting order would hold back from cash until it fills.
			reserved: number;
			cash_before: number;
			cash_after: number;
			cash_change: number;
			position_before: PositionSummary | null;
			position_after: PositionSummary | null;
	  }
	| { ok: false; code: TradingErrorCode; message: string };

export const previewOrder = async (userId: string, input: OrderPreviewInput): Promise<OrderPreview> => {
	const side = sideOfAction(input.action);
	try {
		const price = input.order_type === "market" ? await getFillPrice(input.stock_id) : undefined;
		if (input.order_type === "market" && price === undefined) {
			throw new TradingError("NO_PRICE", "This stock has no price yet. Try again in a moment.");
		}
		const livePrice = input.order_type === "limit" ? ((await getFillPrice(input.stock_id)) ?? null) : null;

		return await dryRun(async (client) => {
			const before = await client.query(
				`SELECT u.cash_balance::float8 AS cash_balance,
					p.volume, p.average_price::float8 AS average_price, p.margin_locked::float8 AS margin_locked
				FROM users u
				LEFT JOIN user_portfolios p ON p.user_id = u.id AND p.stock_id = $2
				WHERE u.id = $1`,
				[userId, input.stock_id],
			);
			const row = before.rows[0] ?? {};
			const cashBefore = Number(row.cash_balance ?? 0);

			const placed =
				input.order_type === "market"
					? await client.query("SELECT bazaar_place_market_order($1, $2, $3, $4, $5, $6) AS result", [
							userId,
							input.stock_id,
							side,
							input.quantity,
							price,
							input.action,
						])
					: await client.query("SELECT bazaar_place_limit_order($1, $2, $3, $4, $5, $6, $7) AS result", [
							userId,
							input.stock_id,
							side,
							input.quantity,
							input.limit_price,
							livePrice,
							input.action,
						]);
			const result = placed.rows[0].result as Record<string, unknown>;
			const cashAfter = Number(result.cash_balance);
			const positionBefore = summarise(
				Number(row.volume ?? 0),
				Number(row.average_price ?? 0),
				Number(row.margin_locked ?? 0),
			);

			if (result.status === "filled") {
				const legs = result.fills as Fill[];
				const position = result.position as { volume: number; average_price: number; margin_locked: number };
				return {
					ok: true,
					status: "filled",
					action: input.action,
					quantity: input.quantity,
					price: Number(result.price),
					legs,
					realized_pnl: Number(result.realized_pnl),
					margin_locked: round2(legs.reduce((total, leg) => total + Number(leg.margin_locked ?? 0), 0)),
					reserved: 0,
					cash_before: cashBefore,
					cash_after: cashAfter,
					cash_change: round2(cashAfter - cashBefore),
					position_before: positionBefore,
					position_after: summarise(
						Number(position.volume),
						Number(position.average_price),
						Number(position.margin_locked),
					),
				};
			}
			return {
				ok: true,
				status: "pending",
				action: input.action,
				quantity: input.quantity,
				price: Number(result.limit_price),
				legs: [],
				realized_pnl: 0,
				margin_locked: 0,
				reserved: round2(Number(result.reserved_cash) + Number(result.reserved_margin)),
				cash_before: cashBefore,
				cash_after: cashAfter,
				cash_change: round2(cashAfter - cashBefore),
				position_before: positionBefore,
				position_after: positionBefore,
			};
		});
	} catch (error) {
		const { code, message } = toTradingError(error);
		if (code === "INTERNAL_ERROR") throw error;
		return { ok: false, code, message };
	}
};

export type IpoApplicationPreview =
	| {
			ok: true;
			lots: number;
			shares: number;
			bid_price: number;
			// Held from cash until allotment.
			amount: number;
			cash_before: number;
			cash_after: number;
	  }
	| { ok: false; code: TradingErrorCode; message: string };

/** What applying would hold back, by dry-running bazaar_apply_ipo. */
export const previewIpoApplication = async (
	userId: string,
	ipoId: number,
	lots: number,
	bidPrice?: number,
): Promise<IpoApplicationPreview> => {
	try {
		return await dryRun(async (client) => {
			const before = await client.query("SELECT cash_balance::float8 AS cash_balance FROM users WHERE id = $1", [
				userId,
			]);
			const placed = await client.query("SELECT bazaar_apply_ipo($1, $2, $3, $4) AS result", [
				userId,
				ipoId,
				lots,
				bidPrice ?? null,
			]);
			const result = placed.rows[0].result as Record<string, unknown>;
			return {
				ok: true,
				lots: Number(result.lots),
				shares: Number(result.lots) * Number(result.lot_size),
				bid_price: Number(result.bid_price),
				amount: Number(result.amount_blocked),
				cash_before: Number(before.rows[0]?.cash_balance ?? 0),
				cash_after: Number(result.cash_balance),
			};
		});
	} catch (error) {
		const { code, message } = toTradingError(error);
		if (code === "INTERNAL_ERROR") throw error;
		return { ok: false, code, message };
	}
};
