import type { NextFunction, Request, Response } from "express";
import { getSessionUser } from "../lib/session.js";
import { sendTradingError, TradingError } from "../trading/errors.js";

/**
 * Trading waits until a newly approved player has confirmed their profile.
 * The player app shows the onboarding dialog first; this closes the door for
 * anyone who calls the API directly. Runs after requireApprovedUser.
 */
const requireOnboarded = (_req: Request, res: Response, next: NextFunction) => {
	const user = getSessionUser(res) as { role?: string | null; onboarded_at?: Date | string | null };
	if (user.role === "user" && !user.onboarded_at) {
		return sendTradingError(
			res,
			new TradingError("ONBOARDING_REQUIRED", "Finish setting up your profile before you trade."),
		);
	}
	next();
};

export default requireOnboarded;
