import type { Request, Response } from "express";
import sql from "../database/database.js";
import { emitToMarket } from "../realtime/emitter.js";

export const getLeaderboardData = async () => {
	const leaderboardData = await sql`
			SELECT 
				u.id, 
				u.name, 
				u.image,
				(u.cash_balance + COALESCE(SUM(p.average_price * p.volume), 0)) AS total_profit
			FROM users u
			LEFT JOIN user_portfolios p ON u.id = p.user_id
			GROUP BY u.id, u.name, u.image, u.cash_balance
            ORDER BY total_profit DESC
            LIMIT 10
        `;
	return leaderboardData;
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
