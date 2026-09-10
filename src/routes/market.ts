import { Router } from "express";

import {
	getMarketState,
	setMarketPaused,
	setMarketSentiment,
} from "../controller/market.js";
import {
	getIndexHistory,
	getMarketOverview,
} from "../controller/marketOverview.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import { MARKET_SENTIMENTS, type MarketSentiment } from "../models/market.js";

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
	const { points } = req.query;

	try {
		const history = await getIndexHistory(
			points === undefined ? undefined : Number(points),
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
