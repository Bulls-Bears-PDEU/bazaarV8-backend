import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

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

	if (session.user.role === "pending") {
		return res.status(403).json({
			message: "Forbidden: Waiting for admin approval",
		});
	}

	next();
};

export default requireApprovedUser;
