import sql from "../database/database.js";
import { sharedCache } from "../lib/sharedCache.js";
import {
	indexHistoryCache,
	newsCache,
	stocksCache,
} from "../lib/sharedReads.js";
import type { MarketMover, MarketSector } from "../models/market.js";
import { getLeaderboardData, rankChange } from "./leaderboard.js";
import { getMarketState } from "./market.js";
import { getCurrentIndex } from "./marketOverview.js";
import { STARTING_CAPITAL } from "./portfolio.js";

/**
 * Everything the live board on the auditorium projector shows, in one read
 * that needs no session: the top of the leaderboard, the Bazaar index, movers,
 * sectors, a few headline figures and the latest headlines.
 *
 * Only what is already public in the room goes out: names and photos of the
 * players on the board (photos are public already), never emails, holdings
 * or anyone below the cut. With limit "all" that is every ranked player. Shared by every screen showing it, so the database
 * is read about once per LIVE_BOARD_TTL_MS however many are open.
 */

const DEFAULT_LEADERS = 10;
const MAX_LEADERS = 30;
// Candles close every 10 seconds: 180 of them is the last half hour.
const INDEX_POINTS = 180;
const HEADLINES = 6;
// Trades this recent count towards the "trades per minute" pulse.
const PULSE_MINUTES = 5;
const LIVE_BOARD_TTL_MS = 2_000;

export type LiveLeader = {
	id: string;
	rank: number;
	// Places climbed (positive) or fallen over the last few minutes.
	rank_change: number | null;
	name: string;
	image: string | null;
	net_worth: number;
	pnl: number;
	return_pct: number;
};

export type LiveMover = {
	stock_id: number;
	symbol: string;
	name: string;
	sector: string;
	change_pct: number;
};

export type LiveBoard = {
	generated_at: string;
	market: { is_paused: boolean; paused_at: string | null };
	index: {
		level: number | null;
		change_pct: number | null;
		advancing: number;
		declining: number;
		unchanged: number;
		priced_stocks: number;
		points: { timestamp: string; value: number; change_pct: number }[];
	};
	leaders: LiveLeader[];
	movers: { gainers: LiveMover[]; losers: LiveMover[] };
	sectors: MarketSector[];
	stats: {
		players: number;
		in_profit: number;
		in_profit_pct: number | null;
		trade_count: number;
		traders: number;
		traded_value: number;
		trades_per_minute: number;
	};
	headlines: { id: number; title: string; release_at: string }[];
};

/** The top N, at most MAX_LEADERS, or "all": the whole board, which the screen pages through. */
export type LeaderLimit = number | "all";

export const clampLeaders = (limit: unknown): LeaderLimit => {
	if (limit === "all") return "all";
	const value = Math.trunc(Number(limit));
	return Number.isFinite(value) && value > 0
		? Math.min(value, MAX_LEADERS)
		: DEFAULT_LEADERS;
};

const returnPct = (pnl: number) => (pnl / STARTING_CAPITAL) * 100;

const getLiveBoard = async (limit: LeaderLimit): Promise<LiveBoard> => {
	const [board, state, index, history, stocks, news, activityRows] =
		await Promise.all([
			getLeaderboardData(),
			getMarketState(),
			getCurrentIndex(),
			indexHistoryCache.get({ points: INDEX_POINTS, basis: "start" }),
			stocksCache.get(undefined),
			newsCache.get(undefined),
			// Players only, like the leaderboard: an organiser trading from god
			// mode is not part of the game the room is watching.
			sql`
				SELECT
					COUNT(*)::int AS trade_count,
					COUNT(DISTINCT t.user_id)::int AS traders,
					COALESCE(SUM(t.volume * t.price), 0)::float8 AS traded_value,
					COUNT(*) FILTER (
						WHERE t.timestamp > LOCALTIMESTAMP - make_interval(mins => ${PULSE_MINUTES})
					)::int AS recent_trades
				FROM user_stock_transactions t
				JOIN users u ON u.id = t.user_id
				WHERE u.role = 'user'
			`,
		]);

	const byId = new Map(stocks.map((stock) => [Number(stock.id), stock]));
	const toMover = ({ stock_id, change_pct }: MarketMover): LiveMover[] => {
		const stock = byId.get(stock_id);
		if (!stock) return [];
		return [
			{
				stock_id,
				symbol: stock.symbol,
				name: stock.name,
				sector: stock.sector,
				change_pct,
			},
		];
	};

	const activity = activityRows[0];
	const inProfit = board.filter((row) => row.pnl > 0).length;

	return {
		generated_at: new Date().toISOString(),
		market: { is_paused: state.is_paused, paused_at: state.paused_at },
		index: {
			level: index.level,
			change_pct: index.change_pct,
			advancing: index.advancing,
			declining: index.declining,
			unchanged: index.unchanged,
			priced_stocks: index.priced_stocks,
			points: history.points,
		},
		leaders: (limit === "all" ? board : board.slice(0, limit)).map((row) => ({
			id: row.id,
			rank: row.rank,
			rank_change: rankChange(row),
			name: row.name,
			image: row.image,
			net_worth: row.net_worth,
			pnl: row.pnl,
			return_pct: returnPct(row.pnl),
		})),
		movers: {
			gainers: index.top_gainers.flatMap(toMover),
			losers: index.top_losers.flatMap(toMover),
		},
		sectors: index.sectors,
		stats: {
			players: board.length,
			in_profit: inProfit,
			in_profit_pct: board.length ? (inProfit / board.length) * 100 : null,
			trade_count: Number(activity.trade_count),
			traders: Number(activity.traders),
			traded_value: Number(activity.traded_value),
			trades_per_minute: Number(activity.recent_trades) / PULSE_MINUTES,
		},
		headlines: news.slice(0, HEADLINES).map(({ id, title, release_at }) => ({
			id,
			title,
			release_at,
		})),
	};
};

export const liveBoardCache = sharedCache(LIVE_BOARD_TTL_MS, getLiveBoard);
