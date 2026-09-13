import { Router } from "express";
import {
	getClosedPositions,
	getEquityCurve,
	getPnlSummary,
	getSectorAllocation,
} from "../controller/analytics.js";
import { parsePage } from "../controller/orders.js";
import { getPortfolio } from "../controller/portfolio.js";
import { getSessionUser } from "../lib/session.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import { sendTradingError } from "../trading/errors.js";

const portfolioRouter = Router();

portfolioRouter.use(requireApprovedUser);

portfolioRouter.get("/getPortfolio", async (_req, res) => {
	try {
		res.json(await getPortfolio(getSessionUser(res).id));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// ?points=200 (at most 1000)
portfolioRouter.get("/getEquityCurve", async (req, res) => {
	const requested = Number(req.query.points);
	const points =
		Number.isInteger(requested) && requested > 1
			? Math.min(requested, 1000)
			: 200;
	try {
		res.json(await getEquityCurve(getSessionUser(res).id, points));
	} catch (error) {
		sendTradingError(res, error);
	}
});

portfolioRouter.get("/getClosedPositions", async (req, res) => {
	try {
		res.json(
			await getClosedPositions(getSessionUser(res).id, parsePage(req.query)),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

portfolioRouter.get("/getPnlSummary", async (_req, res) => {
	try {
		res.json(await getPnlSummary(getSessionUser(res).id));
	} catch (error) {
		sendTradingError(res, error);
	}
});

portfolioRouter.get("/getSectorAllocation", async (_req, res) => {
	try {
		res.json(await getSectorAllocation(getSessionUser(res).id));
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default portfolioRouter;
