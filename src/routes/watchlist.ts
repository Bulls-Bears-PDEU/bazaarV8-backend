import { Router, type Response } from "express";
import {
	addWatchlistItem,
	createWatchlist,
	deleteWatchlist,
	getWatchlists,
	parseWatchlistName,
	removeWatchlistItem,
	renameWatchlist,
	reorderWatchlistItems,
} from "../controller/watchlist.js";
import { getSessionUser } from "../lib/session.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import { sendTradingError, TradingError } from "../trading/errors.js";

const positiveId = (value: unknown, what: string) => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new TradingError("INVALID_INPUT", `${what} must be an id.`);
	}
	return parsed;
};

// Every mutation answers with the full, fresh set of watchlists, so the client
// can replace its cache instead of patching it.
const respondWithWatchlists = async (res: Response, userId: string) => {
	res.json(await getWatchlists(userId));
};

const watchlistRouter = Router();

watchlistRouter.use(requireApprovedUser);

watchlistRouter.get("/getWatchlists", async (_req, res) => {
	try {
		await respondWithWatchlists(res, getSessionUser(res).id);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { name }
watchlistRouter.post("/createWatchlist", async (req, res) => {
	try {
		const userId = getSessionUser(res).id;
		await createWatchlist(userId, parseWatchlistName(req.body?.name));
		await respondWithWatchlists(res.status(201), userId);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { name }
watchlistRouter.patch("/renameWatchlist/:id", async (req, res) => {
	try {
		const userId = getSessionUser(res).id;
		await renameWatchlist(
			userId,
			positiveId(req.params.id, "Watchlist"),
			parseWatchlistName(req.body?.name),
		);
		await respondWithWatchlists(res, userId);
	} catch (error) {
		sendTradingError(res, error);
	}
});

watchlistRouter.delete("/deleteWatchlist/:id", async (req, res) => {
	try {
		const userId = getSessionUser(res).id;
		await deleteWatchlist(userId, positiveId(req.params.id, "Watchlist"));
		await respondWithWatchlists(res, userId);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { stock_id }
watchlistRouter.post("/addItem/:id", async (req, res) => {
	try {
		const userId = getSessionUser(res).id;
		await addWatchlistItem(
			userId,
			positiveId(req.params.id, "Watchlist"),
			positiveId(req.body?.stock_id, "stock_id"),
		);
		await respondWithWatchlists(res, userId);
	} catch (error) {
		sendTradingError(res, error);
	}
});

watchlistRouter.delete("/removeItem/:id/:stockId", async (req, res) => {
	try {
		const userId = getSessionUser(res).id;
		await removeWatchlistItem(
			userId,
			positiveId(req.params.id, "Watchlist"),
			positiveId(req.params.stockId, "Stock"),
		);
		await respondWithWatchlists(res, userId);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { stock_ids: number[] } in the new order.
watchlistRouter.patch("/reorderItems/:id", async (req, res) => {
	try {
		const userId = getSessionUser(res).id;
		const stockIds: unknown = req.body?.stock_ids;
		if (!Array.isArray(stockIds)) {
			throw new TradingError("INVALID_INPUT", "stock_ids must be an array.");
		}
		await reorderWatchlistItems(
			userId,
			positiveId(req.params.id, "Watchlist"),
			stockIds.map((id) => positiveId(id, "stock_ids")),
		);
		await respondWithWatchlists(res, userId);
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default watchlistRouter;
