import type { Response } from "express";
import type { auth } from "./auth.js";

export type SessionUser = typeof auth.$Infer.Session.user;

/**
 * The admin plugin revokes sessions when it bans someone, but a session minted
 * before the ban can outlive it, and a timed ban stays flagged until the next
 * sign-in clears it. Check both explicitly.
 */
export const isBanned = (user: {
	banned?: boolean | null;
	banExpires?: Date | string | null;
}) =>
	Boolean(user.banned) &&
	(!user.banExpires || new Date(user.banExpires).getTime() > Date.now());

/**
 * The signed-in user, attached by requireApprovedUser / requireAdmin. Routes
 * must take the user id from here and never from the request.
 */
export const getSessionUser = (res: Response): SessionUser => {
	const user = res.locals.user as SessionUser | undefined;
	if (!user) {
		throw new Error(
			"getSessionUser called on a route without requireApprovedUser or requireAdmin",
		);
	}
	return user;
};
