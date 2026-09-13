import { Router } from "express";

import {
	getMarketState,
	setMarketPaused,
	setMarketSentiment,
	setTradingRules,
} from "../controller/market.js";
import {
	getIndexHistory,
	getMarketOverview,
} from "../controller/marketOverview.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import {
	MARKET_SENTIMENTS,
	type MarketSentiment,
	type TradingRules,
} from "../models/market.js";

const marketRouter = Router();

marketRouter.use(requireApprovedUser);

marketRouter.get("/getMarketState", async (_, res) => {
	try {
		const state = await getMarketState();
		res.json(state);
	} catch (error) {
		console.error("Error fetching market state:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

marketRouter.get("/getMarketOverview", async (req, res) => {
	const { candles } = req.query;

	try {
		const overview = await getMarketOverview(
			candles === undefined ? undefined : Number(candles),
		);
		res.json(overview);
	} catch (error) {
		console.error("Error fetching market overview:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

marketRouter.get("/getIndexHistory", async (req, res) => {
	const { points, basis } = req.query;

	try {
		// basis=start measures from starting prices (players); the default
		// measures from the window open (the admin overview).
		const history = await getIndexHistory(
			points === undefined ? undefined : Number(points),
			basis === "start" ? "start" : "window",
		);
		res.json(history);
	} catch (error) {
		console.error("Error fetching index history:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

marketRouter.patch("/setPauseState", requireAdmin, async (req, res) => {
	const { isPaused } = req.body;

	if (typeof isPaused !== "boolean") {
		return res.status(400).json({
			error: "isPaused is required and must be a boolean",
		});
	}

	try {
		const state = await setMarketPaused(isPaused);
		res.json(state);
	} catch (error) {
		console.error("Error updating market pause state:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Body: any subset of { short_margin_pct, allow_short_selling,
// allow_limit_orders, max_order_quantity }.
marketRouter.patch("/setTradingRules", requireAdmin, async (req, res) => {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const rules: Partial<TradingRules> = {};

	if (body.short_margin_pct !== undefined) {
		const pct = Number(body.short_margin_pct);
		if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
			return res
				.status(400)
				.json({ error: "short_margin_pct must be above 0 and at most 100" });
		}
		rules.short_margin_pct = pct;
	}
	for (const key of ["allow_short_selling", "allow_limit_orders"] as const) {
		if (body[key] !== undefined) {
			if (typeof body[key] !== "boolean") {
				return res.status(400).json({ error: `${key} must be a boolean` });
			}
			rules[key] = body[key];
		}
	}
	if (body.max_order_quantity !== undefined) {
		const max = Number(body.max_order_quantity);
		if (!Number.isInteger(max) || max <= 0) {
			return res
				.status(400)
				.json({ error: "max_order_quantity must be a whole number above 0" });
		}
		rules.max_order_quantity = max;
	}

	try {
		res.json(await setTradingRules(rules));
	} catch (error) {
		console.error("Error updating trading rules:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

marketRouter.patch("/setSentiment", requireAdmin, async (req, res) => {
	const { sentiment } = req.body;

	if (!MARKET_SENTIMENTS.includes(sentiment as MarketSentiment)) {
		return res.status(400).json({
			error: `sentiment is required and must be one of: ${MARKET_SENTIMENTS.join(", ")}`,
		});
	}

	try {
		const state = await setMarketSentiment(sentiment as MarketSentiment);
		res.json(state);
	} catch (error) {
		console.error("Error updating market sentiment:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

export default marketRouter;
