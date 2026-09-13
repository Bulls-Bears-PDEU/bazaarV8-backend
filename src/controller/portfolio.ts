import sql from "../database/database.js";

// Every player starts with this much (users.cash_balance default).
export const STARTING_CAPITAL = 500_000;

const round2 = (value: number) => Math.round(value * 100) / 100;

export type Position = {
	stock_id: number;
	symbol: string;
	name: string;
	sector: string;
	side: "long" | "short";
	// Signed: negative for a short.
	volume: number;
	average_price: number;
	last_price: number;
	// Longs: volume * price. Shorts: the (positive) value of the shares owed.
	market_value: number;
	unrealized_pnl: number;
	unrealized_pnl_pct: number;
	margin_locked: number;
	opened_at: string | null;
	locked: boolean;
};

/**
 * Open positions marked to the latest price, plus the account totals.
 *
 * net_worth = cash + frozen + long market value + short unrealized P&L.
 * A short counts only its P&L: the margin backing it is already inside
 * frozen_balance, and its proceeds were never credited.
 */
export const getPortfolio = async (userId: string) => {
	const [positionRows, userRows, realizedRows] = await Promise.all([
		sql`
			SELECT
				p.stock_id, s.symbol, s.name, s.sector, s.locked,
				p.volume,
				p.average_price::float8 AS average_price,
				p.margin_locked::float8 AS margin_locked,
				p.opened_at,
				COALESCE(s.last_price, p.average_price)::float8 AS last_price
			FROM user_portfolios p
			JOIN stocks s ON s.id = p.stock_id
			WHERE p.user_id = ${userId} AND p.volume <> 0
			ORDER BY s.symbol
		`,
		sql`
			SELECT cash_balance::float8 AS cash_balance, frozen_balance::float8 AS frozen_balance
			FROM users WHERE id = ${userId}
		`,
		sql`
			SELECT COALESCE(SUM(realized_pnl), 0)::float8 AS realized_pnl
			FROM closed_positions WHERE user_id = ${userId}
		`,
	]);

	const positions: Position[] = positionRows.map((row) => {
		const volume = Number(row.volume);
		const quantity = Math.abs(volume);
		const isLong = volume > 0;
		const cost = row.average_price * quantity;
		const unrealized = isLong
			? (row.last_price - row.average_price) * quantity
			: (row.average_price - row.last_price) * quantity;
		return {
			stock_id: row.stock_id,
			symbol: row.symbol,
			name: row.name,
			sector: row.sector,
			side: isLong ? "long" : "short",
			volume,
			average_price: row.average_price,
			last_price: row.last_price,
			market_value: round2(row.last_price * quantity),
			unrealized_pnl: round2(unrealized),
			unrealized_pnl_pct: cost > 0 ? round2((unrealized / cost) * 100) : 0,
			margin_locked: row.margin_locked,
			opened_at: row.opened_at,
			locked: Boolean(row.locked),
		};
	});

	const cash = userRows[0]?.cash_balance ?? 0;
	const frozen = userRows[0]?.frozen_balance ?? 0;
	const longs = positions.filter((p) => p.side === "long");
	const shorts = positions.filter((p) => p.side === "short");
	const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

	const holdingsValue = sum(longs.map((p) => p.market_value));
	const shortExposure = sum(shorts.map((p) => p.market_value));
	const unrealizedPnl = sum(positions.map((p) => p.unrealized_pnl));
	const shortPnl = sum(shorts.map((p) => p.unrealized_pnl));
	const netWorth = cash + frozen + holdingsValue + shortPnl;

	return {
		cash_balance: cash,
		frozen_balance: frozen,
		positions,
		totals: {
			invested: round2(sum(longs.map((p) => p.average_price * p.volume))),
			holdings_value: round2(holdingsValue),
			short_exposure: round2(shortExposure),
			margin_used: round2(sum(shorts.map((p) => p.margin_locked))),
			gross_exposure: round2(holdingsValue + shortExposure),
			net_exposure: round2(holdingsValue - shortExposure),
			unrealized_pnl: round2(unrealizedPnl),
			realized_pnl: realizedRows[0].realized_pnl as number,
			net_worth: round2(netWorth),
			starting_capital: STARTING_CAPITAL,
			return_pct: round2(
				((netWorth - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
			),
		},
	};
};
