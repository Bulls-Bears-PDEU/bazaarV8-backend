import type { Request, Response } from "express";
import sql from "../database/database.js";
import { getSessionUser } from "../lib/session.js";
import { emitToMarket } from "../realtime/emitter.js";
import { STARTING_CAPITAL } from "./portfolio.js";

/**
 * Net worth, marked to the live price, for every player (role 'user'; admins,
 * pending accounts and accounts an organiser hid are not ranked):
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
		WHERE u.role = 'user' AND NOT u.hidden_from_leaderboard
		GROUP BY u.id, u.name, u.image, u.cash_balance, u.frozen_balance
	),
	ranked AS (
		SELECT *, RANK() OVER (ORDER BY net_worth DESC)::int AS rank
		FROM net_worths
	)
`;

export type Standing = {
	id: string;
	name: string;
	image: string | null;
	rank: number;
	net_worth: number;
	pnl: number;
	total_profit: number;
};

type Board = { rows: Standing[]; byId: Map<string, Standing> };

/**
 * Every ranked player, worked out in one query and kept in memory until the
 * next refresh. Ranking is the most expensive read in the game; done once per
 * LEADERBOARD_REFRESH_MS, the board and each player's own rank are then free
 * to serve however many players ask.
 */
export const LEADERBOARD_REFRESH_MS = 10_000;

let board: Board | null = null;
let refreshing: Promise<Board> | null = null;

/**
 * How far each player has climbed over roughly the last few minutes, for the
 * live board on the projector. Every refresh's ranks are kept, at most one set
 * per half refresh (trades re-rank more often), and players are compared with
 * the oldest set still inside the window.
 */
const RANK_CHANGE_WINDOW_MS = 5 * 60_000;
const rankHistory: { at: number; ranks: Map<string, number> }[] = [];

const recordRanks = (rows: Standing[]) => {
	const now = Date.now();
	const latest = rankHistory[rankHistory.length - 1];
	if (latest && now - latest.at < LEADERBOARD_REFRESH_MS / 2) return;
	rankHistory.push({
		at: now,
		ranks: new Map(rows.map((row) => [row.id, row.rank])),
	});
	while (
		rankHistory.length > 1 &&
		now - rankHistory[0].at > RANK_CHANGE_WINDOW_MS
	) {
		rankHistory.shift();
	}
};

/** Places climbed (positive) or fallen in the window; null for a player not ranked at its start. */
export const rankChange = (standing: Standing): number | null => {
	const before = rankHistory[0]?.ranks.get(standing.id);
	return before === undefined ? null : before - standing.rank;
};

const loadBoard = async (): Promise<Board> => {
	const rows = (await sql`
		${NET_WORTH_CTE}
		SELECT id, name, image, rank, net_worth,
			-- Profit or loss against the cash every player starts with.
			(net_worth - ${STARTING_CAPITAL})::float8 AS pnl,
			-- The admin panel reads this name; it has always meant net worth.
			net_worth AS total_profit
		FROM ranked
		ORDER BY rank, name
	`) as Standing[];
	recordRanks(rows);
	return { rows, byId: new Map(rows.map((row) => [row.id, row])) };
};

const refreshBoard = () => {
	refreshing ??= loadBoard()
		.then((fresh) => {
			board = fresh;
			return fresh;
		})
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
};

const currentBoard = async () => board ?? refreshBoard();

export const getLeaderboardData = async () => (await currentBoard()).rows;

/**
 * Null for admins, hidden accounts and anyone approved since the last refresh.
 * fresh re-ranks first, for a caller that has just changed balances itself.
 */
export const getRankForUser = async (
	userId: string,
	{ fresh = false } = {},
) => {
	const { rows, byId } = fresh ? await refreshBoard() : await currentBoard();
	const standing = byId.get(userId);
	return standing
		? {
				rank: standing.rank,
				net_worth: standing.net_worth,
				total_players: rows.length,
			}
		: null;
};

/**
 * Re-ranks everyone and tells approved players and admins it changed. The
 * signal carries no rows: the whole board is too big to push to every socket
 * every few seconds, and only screens showing it (or a rank) fetch it again.
 */
export const broadcastLeaderboard = async () => {
	try {
		await refreshBoard();
		emitToMarket("leaderboard_update", {
			updated_at: new Date().toISOString(),
		});
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

/** The caller's rank. Null rank for admins and hidden accounts, which are not ranked. */
export const getMyRank = async (_: Request, res: Response) => {
	try {
		const rank = await getRankForUser(getSessionUser(res).id);
		res.json(rank ?? { rank: null, net_worth: null, total_players: null });
	} catch (error) {
		console.error("Error fetching rank:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
