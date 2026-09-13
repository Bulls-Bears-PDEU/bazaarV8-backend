import type { NextFunction, Request, Response } from "express";
import { getMarketState } from "../controller/market.js";

/**
 * Refuses the request while the market is paused. Free: the market state is
 * cached in memory. The settlement function re-checks inside the transaction,
 * so this is the fast, friendly path rather than the guarantee.
 */
const requireMarketOpen = async (
	_req: Request,
	res: Response,
	next: NextFunction,
) => {
	const state = await getMarketState();
	if (state.is_paused) {
		return res
			.status(403)
			.json({ error: "The market is paused.", code: "MARKET_PAUSED" });
	}
	next();
};

export default requireMarketOpen;
