import { Router } from "express";
import {
	cancelAlert,
	createAlert,
	getAlerts,
	parseAlertStatus,
} from "../controller/alerts.js";
import { getSessionUser } from "../lib/session.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import { sendTradingError, TradingError } from "../trading/errors.js";

const alertRouter = Router();

alertRouter.use(requireApprovedUser);

// ?status=active|triggered|cancelled
alertRouter.get("/getAlerts", async (req, res) => {
	try {
		res.json(
			await getAlerts(
				getSessionUser(res).id,
				parseAlertStatus(req.query.status),
			),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { stock_id, target_price, direction?: "above" | "below", note? }
// Fires once, as a priceAlertTriggered socket event to the owner.
alertRouter.post("/createAlert", async (req, res) => {
	try {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const stockId = Number(body.stock_id);
		const targetPrice = Number(body.target_price);
		if (!Number.isInteger(stockId) || stockId <= 0) {
			throw new TradingError("INVALID_INPUT", "stock_id must be a stock id.");
		}
		if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
			throw new TradingError(
				"INVALID_INPUT",
				"target_price must be a price above zero.",
			);
		}
		if (
			body.direction !== undefined &&
			body.direction !== "above" &&
			body.direction !== "below"
		) {
			throw new TradingError(
				"INVALID_INPUT",
				'direction must be "above" or "below".',
			);
		}
		if (
			body.note !== undefined &&
			(typeof body.note !== "string" || body.note.length > 140)
		) {
			throw new TradingError(
				"INVALID_INPUT",
				"note must be text of at most 140 characters.",
			);
		}
		const alert = await createAlert(getSessionUser(res).id, {
			stock_id: stockId,
			target_price: Math.round(targetPrice * 100) / 100,
			direction: body.direction as "above" | "below" | undefined,
			note: body.note as string | undefined,
		});
		res.status(201).json(alert);
	} catch (error) {
		sendTradingError(res, error);
	}
});

alertRouter.delete("/cancelAlert/:id", async (req, res) => {
	try {
		const alertId = Number(req.params.id);
		if (!Number.isInteger(alertId) || alertId <= 0) {
			throw new TradingError("ALERT_NOT_FOUND", "Alert not found.");
		}
		res.json(await cancelAlert(getSessionUser(res).id, alertId));
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default alertRouter;
