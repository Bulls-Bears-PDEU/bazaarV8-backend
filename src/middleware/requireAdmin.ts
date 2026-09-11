import type { NextFunction, Request, Response } from "express";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { isBanned } from "../lib/session.js";

const requireAdmin = async (
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

	if (session.user.role === "admin" && !isBanned(session.user)) {
		res.locals.user = session.user;
		next();
	} else {
		res.status(403).json({ message: "Forbidden: Admins only" });
	}
};

export default requireAdmin;
