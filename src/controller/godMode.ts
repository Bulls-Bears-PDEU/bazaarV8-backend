/**
 * God mode: an organiser acting directly on a player's account.
 *
 * Everything here goes through the same database functions a player's own
 * trade would, so a position opened or closed from the panel books the same
 * fills, realised P&L, margin and ledger rows as one placed in the app. The
 * alternative -- writing user_portfolios by hand -- would leave accounts that
 * disagree with their own trade history.
 *
 * Every action writes an admin_actions row before returning, and the affected
 * player is pushed the same socket events a real trade sends, so their screen
 * updates while they are looking at it.
 */

import sql from "../database/database.js";
import { type OrderAction, sideOfAction } from "../models/order.js";
import { emitToAdmins, emitToUser } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";
import { removeRestingOrder } from "../trading/matcher.js";
import { placeMarketOrder } from "./orders.js";
import { STARTING_CAPITAL } from "./portfolio.js";

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The account an action is being taken on, with the fields the trail needs. */
type Target = { id: string; name: string; role: string; cash_balance: number };

const loadTarget = async (userId: string): Promise<Target> => {
	const rows = await sql`
		SELECT id, name, role, cash_balance::float8 AS cash_balance
		FROM users WHERE id = ${userId}
	`;
	const row = rows[0];
	if (!row) throw new TradingError("INVALID_INPUT", "No such user.");
	return {
		id: String(row.id),
		name: String(row.name ?? "Unnamed"),
		role: String(row.role ?? "pending"),
		cash_balance: Number(row.cash_balance),
	};
};

export type Admin = { id: string; name: string };

/** Writes the trail. Called on the way out of every action, never skipped. */
const record = async (
	admin: Admin,
	action: string,
	target: Target | null,
	summary: string,
	details: Record<string, unknown> = {},
) => {
	await sql`
		INSERT INTO admin_actions (admin_id, admin_name, action, target_user_id, target_user_name, summary, details)
		VALUES (
			${admin.id}, ${admin.name}, ${action},
			${target?.id ?? null}, ${target?.name ?? null}, ${summary}, ${JSON.stringify(details)}::jsonb
		)
	`;
	emitToAdmins("adminActionLogged", {});
};

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

const MAX_CASH = 1e12;

/**
 * Moves a player's cash. `delta` credits or debits; `absolute` sets the balance
 * outright. Frozen cash is left alone: it belongs to open orders and margin,
 * and releasing it here would leave those unbacked.
 */
export const adjustCash = async (
	admin: Admin,
	userId: string,
	input: { delta?: number; absolute?: number; note?: string },
) => {
	const target = await loadTarget(userId);
	const hasDelta = input.delta !== undefined;
	const hasAbsolute = input.absolute !== undefined;
	if (hasDelta === hasAbsolute) {
		throw new TradingError(
			"INVALID_INPUT",
			"Give either an amount to add or a balance to set, not both.",
		);
	}

	const next = round2(
		hasDelta
			? target.cash_balance + Number(input.delta)
			: Number(input.absolute),
	);
	if (!Number.isFinite(next) || next < 0 || next > MAX_CASH) {
		throw new TradingError(
			"INVALID_INPUT",
			"That would leave a balance below zero or beyond any sane amount.",
		);
	}

	await sql`UPDATE users SET cash_balance = ${next}, "updatedAt" = NOW() WHERE id = ${userId}`;
	emitToUser(userId, "walletUpdate", {});
	emitToAdmins("usersChanged", { id: userId });

	const change = round2(next - target.cash_balance);
	await record(
		admin,
		"cash_adjusted",
		target,
		`${change >= 0 ? "Credited" : "Debited"} ${Math.abs(change).toFixed(2)} (${target.cash_balance.toFixed(2)} to ${next.toFixed(2)})`,
		{
			before: target.cash_balance,
			after: next,
			change,
			note: input.note ?? null,
		},
	);
	return { cash_balance: next, change };
};

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Cancels resting orders, refunding whatever each had set aside. */
const releaseOrders = async (userId: string | null) => {
	const rows = await sql`
		SELECT id::int AS id, user_id
		FROM orders
		WHERE status = 'pending' AND (${userId}::text IS NULL OR user_id = ${userId})
	`;
	const touched = new Set<string>();
	for (const row of rows) {
		const owner = String(row.user_id);
		// bazaar_release_order is the same path a player's own cancel takes, so
		// reserved cash and margin come back exactly as they went out.
		await sql`SELECT bazaar_release_order(${Number(row.id)}, ${owner}, 'cancelled', NULL) AS result`;
		removeRestingOrder(Number(row.id));
		touched.add(owner);
	}
	for (const owner of touched) {
		emitToUser(owner, "orderCancelled", {});
		emitToUser(owner, "walletUpdate", {});
	}
	return rows.length;
};

export const cancelOrdersFor = async (admin: Admin, userId: string) => {
	const target = await loadTarget(userId);
	const cancelled = await releaseOrders(userId);
	emitToAdmins("usersChanged", { id: userId });
	await record(
		admin,
		"orders_cancelled",
		target,
		`Cancelled ${cancelled} open order(s)`,
		{ cancelled },
	);
	return { cancelled };
};

/** Every resting order in the market, for clearing the book before a reset. */
export const cancelAllOrders = async (admin: Admin) => {
	const cancelled = await releaseOrders(null);
	emitToAdmins("usersChanged", {});
	await record(
		admin,
		"orders_cancelled_all",
		null,
		`Cancelled ${cancelled} open order(s) market-wide`,
		{ cancelled },
	);
	return { cancelled };
};

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

const positionsOf = async (userId: string) => {
	const rows = await sql`
		SELECT p.stock_id::int AS stock_id, p.volume::int AS volume, s.symbol
		FROM user_portfolios p
		JOIN stocks s ON s.id = p.stock_id
		WHERE p.user_id = ${userId} AND p.volume <> 0
		ORDER BY s.symbol
	`;
	return rows.map((row) => ({
		stock_id: Number(row.stock_id),
		volume: Number(row.volume),
		symbol: String(row.symbol),
	}));
};

const requireQuantity = (quantity: unknown) => {
	const value = Number(quantity);
	if (!Number.isInteger(value) || value <= 0) {
		throw new TradingError(
			"INVALID_QUANTITY",
			"Quantity must be a whole number of shares above zero.",
		);
	}
	return value;
};

/**
 * Opens or adds to a position on a player's behalf, at the live price.
 *
 * The same refusals a player would meet still apply -- no buying into a short,
 * no shorting while long, no shorting with the market's short selling off --
 * because this is the same settlement function. God mode gets a player into a
 * position; it does not get them into an impossible one.
 */
export const openPositionFor = async (
	admin: Admin,
	userId: string,
	input: { stock_id: number; action: OrderAction; quantity: number },
) => {
	const target = await loadTarget(userId);
	const quantity = requireQuantity(input.quantity);
	if (input.action !== "buy" && input.action !== "short") {
		throw new TradingError(
			"INVALID_INPUT",
			"Opening takes Buy or Short; use close for Sell and Cover.",
		);
	}

	const fill = await placeMarketOrder(userId, {
		stock_id: input.stock_id,
		side: sideOfAction(input.action),
		action: input.action,
		order_type: "market",
		quantity,
	});

	emitToAdmins("usersChanged", { id: userId });
	await record(
		admin,
		"position_opened",
		target,
		`${input.action === "buy" ? "Bought" : "Shorted"} ${quantity} of stock #${input.stock_id} at ${Number(fill.price).toFixed(2)}`,
		{
			stock_id: input.stock_id,
			action: input.action,
			quantity,
			price: fill.price,
			order_id: fill.order_id,
		},
	);
	return fill;
};

/**
 * Closes some or all of one position. Which way it closes is read from the
 * position itself, so there is nothing to get wrong: a long is sold, a short is
 * covered.
 */
export const closePositionFor = async (
	admin: Admin,
	userId: string,
	input: { stock_id: number; quantity?: number },
) => {
	const target = await loadTarget(userId);
	const held = (await positionsOf(userId)).find(
		(p) => p.stock_id === input.stock_id,
	);
	if (!held)
		throw new TradingError("NO_POSITION", "They hold nothing in this stock.");

	const open = Math.abs(held.volume);
	const quantity =
		input.quantity === undefined ? open : requireQuantity(input.quantity);
	if (quantity > open) {
		throw new TradingError(
			"INVALID_QUANTITY",
			`They only hold ${open} share(s) of ${held.symbol}.`,
		);
	}

	const action: OrderAction = held.volume > 0 ? "sell" : "cover";
	const fill = await placeMarketOrder(userId, {
		stock_id: input.stock_id,
		side: sideOfAction(action),
		action,
		order_type: "market",
		quantity,
	});

	emitToAdmins("usersChanged", { id: userId });
	await record(
		admin,
		"position_closed",
		target,
		`${action === "sell" ? "Sold" : "Covered"} ${quantity} ${held.symbol} at ${Number(fill.price).toFixed(2)}`,
		{
			stock_id: input.stock_id,
			symbol: held.symbol,
			action,
			quantity,
			price: fill.price,
			realized_pnl: fill.realized_pnl,
		},
	);
	return fill;
};

/**
 * Closes everything a player holds, cancelling their resting orders first so
 * shares promised to an open sell are not counted twice.
 */
export const flattenUser = async (admin: Admin, userId: string) => {
	const target = await loadTarget(userId);
	const cancelled = await releaseOrders(userId);
	const held = await positionsOf(userId);

	let realized = 0;
	const closed: { symbol: string; quantity: number; realized_pnl: number }[] =
		[];
	for (const position of held) {
		const action: OrderAction = position.volume > 0 ? "sell" : "cover";
		const fill = await placeMarketOrder(userId, {
			stock_id: position.stock_id,
			side: sideOfAction(action),
			action,
			order_type: "market",
			quantity: Math.abs(position.volume),
		});
		realized = round2(realized + Number(fill.realized_pnl));
		closed.push({
			symbol: position.symbol,
			quantity: Math.abs(position.volume),
			realized_pnl: Number(fill.realized_pnl),
		});
	}

	emitToAdmins("usersChanged", { id: userId });
	await record(
		admin,
		"flattened",
		target,
		`Closed ${closed.length} position(s) and ${cancelled} order(s), realising ${realized.toFixed(2)}`,
		{ cancelled, closed, realized_pnl: realized },
	);
	return { cancelled, closed, realized_pnl: realized };
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/**
 * Puts an account back to how it started: orders cancelled, positions closed,
 * cash back to the starting capital and nothing frozen.
 *
 * The trade history is kept by default, since it is the record of what the
 * player did and deleting it would make the leaderboard disagree with the
 * ledger. `wipe_history` throws it away too, for a practice run being cleared
 * before the real event.
 */
export const resetAccount = async (
	admin: Admin,
	userId: string,
	options: { wipe_history?: boolean } = {},
) => {
	const target = await loadTarget(userId);
	const cancelled = await releaseOrders(userId);
	const held = await positionsOf(userId);

	// Closed through the real settlement first, so the ledger and closed_positions
	// show how the account ended rather than positions simply vanishing.
	for (const position of held) {
		const action: OrderAction = position.volume > 0 ? "sell" : "cover";
		await placeMarketOrder(userId, {
			stock_id: position.stock_id,
			side: sideOfAction(action),
			action,
			order_type: "market",
			quantity: Math.abs(position.volume),
		});
	}

	if (options.wipe_history) {
		await sql`DELETE FROM user_stock_transactions WHERE user_id = ${userId}`;
		await sql`DELETE FROM closed_positions WHERE user_id = ${userId}`;
		await sql`DELETE FROM orders WHERE user_id = ${userId}`;
		await sql`DELETE FROM portfolio_snapshots WHERE user_id = ${userId}`;
	}

	await sql`
		UPDATE users
		SET cash_balance = ${STARTING_CAPITAL}, frozen_balance = 0, "updatedAt" = NOW()
		WHERE id = ${userId}
	`;
	await sql`DELETE FROM user_portfolios WHERE user_id = ${userId} AND volume = 0`;

	emitToUser(userId, "walletUpdate", {});
	emitToUser(userId, "orderCancelled", {});
	emitToAdmins("usersChanged", { id: userId });

	await record(
		admin,
		"account_reset",
		target,
		`Reset to ${STARTING_CAPITAL.toFixed(2)}: closed ${held.length} position(s), cancelled ${cancelled} order(s)${options.wipe_history ? ", history wiped" : ""}`,
		{
			cash_before: target.cash_balance,
			cash_after: STARTING_CAPITAL,
			positions_closed: held.length,
			orders_cancelled: cancelled,
			wiped_history: options.wipe_history === true,
		},
	);
	return {
		positions_closed: held.length,
		orders_cancelled: cancelled,
		cash_balance: STARTING_CAPITAL,
	};
};

// ---------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------

/** Logs an action taken elsewhere (role changes, bans) into the same trail. */
export const recordAdminAction = async (
	admin: Admin,
	action: string,
	userId: string | null,
	summary: string,
	details: Record<string, unknown> = {},
) => {
	const target = userId ? await loadTarget(userId).catch(() => null) : null;
	await record(admin, action, target, summary, details);
};

export const listAdminActions = async (query: {
	page?: number;
	page_size?: number;
	user_id?: string;
}) => {
	const page = Math.max(1, Number(query.page) || 1);
	const size = Math.min(100, Math.max(1, Number(query.page_size) || 50));
	const userId = query.user_id ?? null;

	const rows = await sql`
		SELECT id::int AS id, admin_id, admin_name, action, target_user_id, target_user_name,
			summary, details, created_at
		FROM admin_actions
		WHERE ${userId}::text IS NULL OR target_user_id = ${userId}
		ORDER BY created_at DESC, id DESC
		LIMIT ${size} OFFSET ${(page - 1) * size}
	`;
	const totals = await sql`
		SELECT COUNT(*)::int AS total
		FROM admin_actions
		WHERE ${userId}::text IS NULL OR target_user_id = ${userId}
	`;
	return {
		actions: rows,
		total: Number(totals[0]?.total ?? 0),
		page,
		page_size: size,
	};
};

/** What a player currently holds, for the panel's position controls. */
export const getGodModeView = async (userId: string) => {
	const target = await loadTarget(userId);
	const [positions, orders, frozen] = await Promise.all([
		sql`
			SELECT p.stock_id::int AS stock_id, s.symbol, s.name,
				p.volume::int AS volume, p.average_price::float8 AS average_price,
				s.last_price::float8 AS last_price, p.margin_locked::float8 AS margin_locked
			FROM user_portfolios p
			JOIN stocks s ON s.id = p.stock_id
			WHERE p.user_id = ${userId} AND p.volume <> 0
			ORDER BY s.symbol
		`,
		sql`
			SELECT o.id::int AS id, o.stock_id::int AS stock_id, s.symbol, o.action, o.side,
				o.quantity::int AS quantity, o.filled_quantity::int AS filled_quantity,
				o.limit_price::float8 AS limit_price, o.created_at
			FROM orders o
			JOIN stocks s ON s.id = o.stock_id
			WHERE o.user_id = ${userId} AND o.status = 'pending'
			ORDER BY o.created_at DESC
		`,
		sql`SELECT frozen_balance::float8 AS frozen_balance FROM users WHERE id = ${userId}`,
	]);
	return {
		user: { id: target.id, name: target.name, role: target.role },
		cash_balance: target.cash_balance,
		frozen_balance: Number(frozen[0]?.frozen_balance ?? 0),
		positions,
		open_orders: orders,
	};
};
