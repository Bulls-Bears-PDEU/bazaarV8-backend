import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { isBanned } from "../lib/session.js";

const requireApprovedUser = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const session = await auth.api.getSession({
		headers: fromNodeHeaders(req.headers),
	});

	if (!session) {
		return res.status(401).json({ message: "Unauthorized: No session" });
	}

	if (isBanned(session.user)) {
		return res.status(403).json({ message: "Forbidden: Account is banned" });
	}

	if (session.user.role === "pending") {
		return res.status(403).json({
			message: "Forbidden: Waiting for admin approval",
		});
	}

	// Read with getSessionUser(res); saves every route a second session lookup.
	res.locals.user = session.user;
	next();
};

export default requireApprovedUser;
