import sql from "../database/database.js";
import { getMarketState } from "./market.js";
import { getPortfolio, STARTING_CAPITAL } from "./portfolio.js";
import { onlineUserIds } from "../realtime/emitter.js";

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Records net worth for every player with an open socket, in one statement.
 * Only online players: offline accounts cannot change (no one is trading them)
 * except through price moves, and the curve interpolates across the gap.
 * Skipped while paused, when prices cannot move either.
 *
 * Valuation matches getPortfolio and the leaderboard.
 */
export const capturePortfolioSnapshots = async () => {
	const state = await getMarketState();
	if (state.is_paused) return;
	await captureSnapshotsFor(onlineUserIds());
};

export const captureSnapshotsFor = async (userIds: string[]) => {
	if (userIds.length === 0) return;
	await sql`
		INSERT INTO portfolio_snapshots
			(user_id, cash_balance, frozen_balance, holdings_value, short_exposure,
			 realized_pnl, unrealized_pnl, net_worth)
		SELECT
			u.id, u.cash_balance, u.frozen_balance,
			h.holdings_value, h.short_exposure,
			COALESCE(r.realized_pnl, 0), h.unrealized_pnl,
			u.cash_balance + u.frozen_balance + h.holdings_value + h.short_pnl
		FROM users u
		CROSS JOIN LATERAL (
			SELECT
				COALESCE(SUM(p.volume * px.price) FILTER (WHERE p.volume > 0), 0) AS holdings_value,
				COALESCE(SUM(-p.volume * px.price) FILTER (WHERE p.volume < 0), 0) AS short_exposure,
				COALESCE(SUM((p.average_price - px.price) * -p.volume) FILTER (WHERE p.volume < 0), 0) AS short_pnl,
				COALESCE(SUM(
					CASE WHEN p.volume > 0 THEN (px.price - p.average_price) * p.volume
					     ELSE (p.average_price - px.price) * -p.volume END
				), 0) AS unrealized_pnl
			FROM user_portfolios p
			JOIN stocks s ON s.id = p.stock_id
			CROSS JOIN LATERAL (SELECT COALESCE(s.last_price, p.average_price) AS price) px
			WHERE p.user_id = u.id AND p.volume <> 0
		) h
		LEFT JOIN LATERAL (
			SELECT SUM(realized_pnl) AS realized_pnl FROM closed_positions WHERE user_id = u.id
		) r ON TRUE
		WHERE u.id = ANY(${userIds}::text[]) AND u.role = 'user'
	`;
};

/**
 * The equity curve, downsampled to at most `points`. It starts from the
 * starting capital at sign-up and ends with a live point computed now, so it
 * is never empty and never stale.
 */
export const getEquityCurve = async (userId: string, points = 200) => {
	const [snapshots, userRows, portfolio] = await Promise.all([
		sql`
			SELECT net_worth::float8 AS net_worth, captured_at
			FROM (
				SELECT net_worth, captured_at FROM portfolio_snapshots
				WHERE user_id = ${userId}
				ORDER BY captured_at DESC
				LIMIT 5000
			) recent
			ORDER BY captured_at ASC
		`,
		sql`SELECT "createdAt" AS created_at FROM users WHERE id = ${userId}`,
		getPortfolio(userId),
	]);

	const stride = Math.max(1, Math.ceil(snapshots.length / points));
	const sampled = snapshots.filter(
		(_, index) => index % stride === 0 || index === snapshots.length - 1,
	);

	const series = [
		{
			timestamp: new Date(userRows[0]?.created_at ?? Date.now()).toISOString(),
			net_worth: STARTING_CAPITAL,
		},
		...sampled.map((row) => ({
			timestamp: new Date(row.captured_at).toISOString(),
			net_worth: row.net_worth as number,
		})),
		{ timestamp: new Date().toISOString(), net_worth: portfolio.totals.net_worth },
	];
	return { points: series, starting_capital: STARTING_CAPITAL };
};

export const getClosedPositions = async (
	userId: string,
	page: { limit: number; offset: number },
) => {
	const [rows, count] = await Promise.all([
		sql`
			SELECT
				c.id::int AS id, c.stock_id, s.symbol, s.name, c.side, c.quantity,
				c.entry_price::float8 AS entry_price, c.exit_price::float8 AS exit_price,
				c.realized_pnl::float8 AS realized_pnl,
				CASE WHEN c.entry_price * c.quantity > 0
					THEN (c.realized_pnl / (c.entry_price * c.quantity) * 100)::float8
					ELSE 0 END AS realized_pnl_pct,
				c.opened_at, c.closed_at
			FROM closed_positions c JOIN stocks s ON s.id = c.stock_id
			WHERE c.user_id = ${userId}
			ORDER BY c.closed_at DESC, c.id DESC
			LIMIT ${page.limit} OFFSET ${page.offset}
		`,
		sql`SELECT count(*)::int AS total FROM closed_positions WHERE user_id = ${userId}`,
	]);
	return { positions: rows, total: count[0].total as number };
};

/** Win rate and friends, over every closed slice. */
export const getPnlSummary = async (userId: string) => {
	const [[stats], portfolio] = await Promise.all([
		sql`
			SELECT
				count(*)::int AS closed_count,
				count(*) FILTER (WHERE realized_pnl > 0)::int AS win_count,
				count(*) FILTER (WHERE realized_pnl < 0)::int AS loss_count,
				COALESCE(MAX(realized_pnl), 0)::float8 AS best_trade,
				COALESCE(MIN(realized_pnl), 0)::float8 AS worst_trade,
				(SELECT count(*)::int FROM user_stock_transactions WHERE user_id = ${userId}) AS trade_count
			FROM closed_positions WHERE user_id = ${userId}
		`,
		getPortfolio(userId),
	]);
	const { realized_pnl, unrealized_pnl, net_worth } = portfolio.totals;
	return {
		realized_pnl,
		unrealized_pnl,
		total_pnl: round2(net_worth - STARTING_CAPITAL),
		starting_capital: STARTING_CAPITAL,
		return_pct: portfolio.totals.return_pct,
		trade_count: stats.trade_count,
		closed_count: stats.closed_count,
		win_count: stats.win_count,
		loss_count: stats.loss_count,
		win_rate:
			stats.closed_count > 0
				? round2((stats.win_count / stats.closed_count) * 100)
				: null,
		best_trade: stats.best_trade,
		worst_trade: stats.worst_trade,
	};
};

/** Long holdings by sector, weighted by market value. Shorts listed apart. */
export const getSectorAllocation = async (userId: string) => {
	const { positions, totals, cash_balance } = await getPortfolio(userId);
	const bySector = new Map<
		string,
		{ market_value: number; unrealized_pnl: number; position_count: number }
	>();
	for (const position of positions.filter((p) => p.side === "long")) {
		const entry = bySector.get(position.sector) ?? {
			market_value: 0,
			unrealized_pnl: 0,
			position_count: 0,
		};
		entry.market_value += position.market_value;
		entry.unrealized_pnl += position.unrealized_pnl;
		entry.position_count += 1;
		bySector.set(position.sector, entry);
	}
	const total = totals.holdings_value;
	return {
		sectors: [...bySector]
			.map(([sector, entry]) => ({
				sector,
				market_value: round2(entry.market_value),
				weight_pct: total > 0 ? round2((entry.market_value / total) * 100) : 0,
				unrealized_pnl: round2(entry.unrealized_pnl),
				position_count: entry.position_count,
			}))
			.sort((a, b) => b.market_value - a.market_value),
		holdings_value: total,
		short_exposure: totals.short_exposure,
		// Not part of the sector weights; the UI can show it as its own slice.
		cash_balance,
	};
};
