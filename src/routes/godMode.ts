import { Router } from "express";
import {
	adjustCash,
	cancelAllOrders,
	cancelOrdersFor,
	closePositionFor,
	flattenUser,
	getGodModeView,
	listAdminActions,
	openPositionFor,
	resetAccount,
} from "../controller/godMode.js";
import { getSessionUser } from "../lib/session.js";
import requireAdmin from "../middleware/requireAdmin.js";
import type { OrderAction } from "../models/order.js";
import { sendTradingError, TradingError } from "../trading/errors.js";

/**
 * God mode: direct control over a player's account.
 *
 * Every route is admin-only and every action writes to admin_actions, so there
 * is always a record of who moved someone else's money. Nothing here bypasses
 * the trading rules: positions are opened and closed through the same
 * settlement a player's own order uses.
 */
const godModeRouter = Router();

godModeRouter.use(requireAdmin);

/** The signed-in organiser, as the trail records them. */
const actingAdmin = (res: Parameters<typeof getSessionUser>[0]) => {
	const user = getSessionUser(res);
	return { id: user.id, name: user.name ?? "Admin" };
};

const userIdParam = (value: unknown) => {
	const id = String(value ?? "");
	if (!id) throw new TradingError("INVALID_INPUT", "Which user?");
	return id;
};

const stockIdOf = (value: unknown) => {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) {
		throw new TradingError("INVALID_INPUT", "Which stock?");
	}
	return id;
};

// The trail. ?page=&page_size=&user_id=
godModeRouter.get("/actions", async (req, res) => {
	try {
		res.json(await listAdminActions(req.query as Record<string, string>));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Everything god mode can act on for one player.
godModeRouter.get("/users/:id", async (req, res) => {
	try {
		res.json(await getGodModeView(userIdParam(req.params.id)));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { delta } or { absolute }, plus an optional note for the trail.
godModeRouter.post("/users/:id/cash", async (req, res) => {
	try {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const result = await adjustCash(
			actingAdmin(res),
			userIdParam(req.params.id),
			{
				delta: body.delta === undefined ? undefined : Number(body.delta),
				absolute:
					body.absolute === undefined ? undefined : Number(body.absolute),
				note:
					typeof body.note === "string"
						? body.note.trim().slice(0, 200) || undefined
						: undefined,
			},
		);
		res.json(result);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { stock_id, action: 'buy' | 'short', quantity }.
godModeRouter.post("/users/:id/positions", async (req, res) => {
	try {
		const body = (req.body ?? {}) as Record<string, unknown>;
		res.json(
			await openPositionFor(actingAdmin(res), userIdParam(req.params.id), {
				stock_id: stockIdOf(body.stock_id),
				action: String(body.action ?? "") as OrderAction,
				quantity: Number(body.quantity),
			}),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { quantity? }. Omitted closes the whole position.
godModeRouter.post("/users/:id/positions/:stockId/close", async (req, res) => {
	try {
		const body = (req.body ?? {}) as Record<string, unknown>;
		res.json(
			await closePositionFor(actingAdmin(res), userIdParam(req.params.id), {
				stock_id: stockIdOf(req.params.stockId),
				quantity:
					body.quantity === undefined ? undefined : Number(body.quantity),
			}),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

godModeRouter.post("/users/:id/flatten", async (req, res) => {
	try {
		res.json(await flattenUser(actingAdmin(res), userIdParam(req.params.id)));
	} catch (error) {
		sendTradingError(res, error);
	}
});

godModeRouter.post("/users/:id/cancel-orders", async (req, res) => {
	try {
		res.json(
			await cancelOrdersFor(actingAdmin(res), userIdParam(req.params.id)),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { wipe_history?: boolean }.
godModeRouter.post("/users/:id/reset", async (req, res) => {
	try {
		const body = (req.body ?? {}) as Record<string, unknown>;
		res.json(
			await resetAccount(actingAdmin(res), userIdParam(req.params.id), {
				wipe_history: body.wipe_history === true,
			}),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Every resting order in the market.
godModeRouter.post("/orders/cancel-all", async (_req, res) => {
	try {
		res.json(await cancelAllOrders(actingAdmin(res)));
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default godModeRouter;
