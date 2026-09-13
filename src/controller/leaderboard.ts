import type { Request, Response } from "express";
import sql from "../database/database.js";
import { getSessionUser } from "../lib/session.js";
import { emitToMarket } from "../realtime/emitter.js";

/**
 * Net worth, marked to the live price, for every player (role 'user'; admins
 * and pending accounts are not ranked):
 *   cash + frozen + long volume * price + short (entry - price) * qty
 *
 * The old query summed average_price * volume: valued at cost rather than
 * market, ignored frozen_balance, and with a negative (short) volume it
 * subtracted the whole short notional, sinking a player the moment they
 * shorted. Frozen already holds the short margin, so margin is not added again.
 */
const NET_WORTH_CTE = sql`
	WITH net_worths AS (
		SELECT
			u.id,
			u.name,
			u.image,
			(u.cash_balance + u.frozen_balance + COALESCE(SUM(
				CASE
					WHEN p.volume > 0 THEN p.volume * COALESCE(s.last_price, p.average_price)
					ELSE (p.average_price - COALESCE(s.last_price, p.average_price)) * (-p.volume)
				END
			), 0))::float8 AS net_worth
		FROM users u
		LEFT JOIN user_portfolios p ON p.user_id = u.id AND p.volume <> 0
		LEFT JOIN stocks s ON s.id = p.stock_id
		WHERE u.role = 'user'
		GROUP BY u.id, u.name, u.image, u.cash_balance, u.frozen_balance
	),
	ranked AS (
		SELECT *, RANK() OVER (ORDER BY net_worth DESC)::int AS rank
		FROM net_worths
	)
`;

export const getLeaderboardData = async () => {
	const rows = await sql`
		${NET_WORTH_CTE}
		SELECT id, name, image, rank, net_worth,
			-- The admin panel reads this name; it has always meant net worth.
			net_worth AS total_profit
		FROM ranked
		ORDER BY rank, name
		LIMIT 10
	`;
	return rows;
};

export const getRankForUser = async (userId: string) => {
	const rows = await sql`
		${NET_WORTH_CTE}
		SELECT
			r.rank, r.net_worth,
			(SELECT count(*)::int FROM ranked) AS total_players
		FROM ranked r
		WHERE r.id = ${userId}
	`;
	return (rows[0] ?? null) as {
		rank: number;
		net_worth: number;
		total_players: number;
	} | null;
};

// Approved players and admins only: this carries every leader's name and net
// worth, so it must not reach pending or unauthenticated sockets.
export const broadcastLeaderboard = async () => {
	try {
		const data = await getLeaderboardData();
		emitToMarket("leaderboard_update", data);
	} catch (error) {
		console.error("Error broadcasting leaderboard:", error);
	}
};

export const getLeaderboard = async (_: Request, res: Response) => {
	try {
		const leaderboardData = await getLeaderboardData();
		res.json(leaderboardData);
	} catch (error) {
		console.error("Error fetching leaderboard:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

/** The caller's rank. Null rank for admins, who are not ranked. */
export const getMyRank = async (_: Request, res: Response) => {
	try {
		const rank = await getRankForUser(getSessionUser(res).id);
		res.json(rank ?? { rank: null, net_worth: null, total_players: null });
	} catch (error) {
		console.error("Error fetching rank:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
