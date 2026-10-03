import type { NextFunction, Request, Response } from "express";
import { getRequestSession } from "../lib/requestSession.js";
import { isBanned, type SessionUser } from "../lib/session.js";

const requireAdmin = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Usually requireApprovedUser has already looked the session up, with the
	// same freshness rules; no need to do it twice.
	const user =
		(res.locals.user as SessionUser | undefined) ??
		(await getRequestSession(req, res))?.user;
	if (!user) {
		return res.status(401).json({ message: "Unauthorized: No session" });
	}

	if (user.role === "admin" && !isBanned(user)) {
		res.locals.user = user;
		next();
	} else {
		res.status(403).json({ message: "Forbidden: Admins only" });
	}
};

export default requireAdmin;
