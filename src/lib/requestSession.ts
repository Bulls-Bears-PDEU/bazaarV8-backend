import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { auth } from "./auth.js";

/**
 * The caller's session, for the HTTP guards.
 *
 * Reads trust Better Auth's signed session cookie cache (see auth.ts), so a
 * page load does not cost a database lookup; a ban or role change reaches them
 * within the cache's maxAge. Anything that writes (an order, an admin action)
 * always checks the database, so a banned or demoted account cannot act on a
 * cookie it was issued earlier.
 *
 * Better Auth refreshes the cache cookie as part of the lookup; it is passed on
 * to the response, or the cache would expire a minute after the browser last
 * called Better Auth itself and every request after that would miss it.
 */
export const getRequestSession = async (req: Request, res: Response) => {
	const isRead = req.method === "GET" || req.method === "HEAD";
	const { headers, response } = await auth.api.getSession({
		headers: fromNodeHeaders(req.headers),
		query: { disableCookieCache: !isRead },
		returnHeaders: true,
	});
	const cookies = headers.getSetCookie();
	if (cookies.length && !res.headersSent) res.append("Set-Cookie", cookies);
	return response;
};
