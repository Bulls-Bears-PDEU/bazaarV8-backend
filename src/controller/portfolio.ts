import sql from "../database/database.js";
import { getLivePrice } from "../stockEngine.js";

// Every player starts with this much (users.cash_balance default).
export const STARTING_CAPITAL = 500_000;

// The allocation ring shows at most this many sectors; the rest become "Other".
const ALLOCATION_SECTORS = 4;

const round2 = (value: number) => Math.round(value * 100) / 100;

export type Position = {
	stock_id: number;
	symbol: string;
	name: string;
	sector: string;
	side: "long" | "short";
	// Signed: negative for a short.
	volume: number;
	// Shares held or owed, always positive.
	quantity: number;
	average_price: number;
	// The live price when the engine has one, else the last price it wrote.
	last_price: number;
	// Longs: quantity * price. Shorts: the (positive) value of the shares owed.
	market_value: number;
	unrealized_pnl: number;
	unrealized_pnl_pct: number;
	margin_locked: number;
	opened_at: string | null;
	locked: boolean;
};

export type AllocationSlice = {
	label: string;
	kind: "sector" | "other" | "cash";
	value: number;
	// Share of cash plus long holdings.
	pct: number;
};

export type Portfolio = {
	cash_balance: number;
	frozen_balance: number;
	positions: Position[];
	totals: {
		invested: number;
		holdings_value: number;
		short_exposure: number;
		margin_used: number;
		gross_exposure: number;
		net_exposure: number;
		unrealized_pnl: number;
		realized_pnl: number;
		net_worth: number;
		starting_capital: number;
		// net_worth - starting_capital.
		total_pnl: number;
		return_pct: number;
		long_count: number;
		short_count: number;
		// Shares of cash + frozen + long holdings, for the account bar.
		cash_share_pct: number;
		frozen_share_pct: number;
	};
	// Long holdings by sector plus cash: the allocation ring, largest first.
	allocation: {
		slices: AllocationSlice[];
		invested: number;
	};
	valued_at: string;
};

/** What a portfolio is built from: rows that only change when the player trades. */
export type PortfolioInputs = {
	cash_balance: number;
	frozen_balance: number;
	realized_pnl: number;
	positions: {
		stock_id: number;
		symbol: string;
		name: string;
		sector: string;
		locked: boolean;
		volume: number;
		average_price: number;
		margin_locked: number;
		opened_at: string | null;
		// stocks.last_price, used when the engine has no live price.
		stored_price: number;
	}[];
};

/** The inputs for many players in three queries, keyed by user id. */
export const loadPortfolioInputs = async (
	userIds: string[],
): Promise<Map<string, PortfolioInputs>> => {
	const result = new Map<string, PortfolioInputs>();
	if (userIds.length === 0) return result;

	const [userRows, positionRows, realizedRows] = await Promise.all([
		sql`
			SELECT id, cash_balance::float8 AS cash_balance, frozen_balance::float8 AS frozen_balance
			FROM users WHERE id = ANY(${userIds}::text[])
		`,
		sql`
			SELECT
				p.user_id, p.stock_id, s.symbol, s.name, s.sector, s.locked,
				p.volume,
				p.average_price::float8 AS average_price,
				p.margin_locked::float8 AS margin_locked,
				p.opened_at,
				COALESCE(s.last_price, p.average_price)::float8 AS stored_price
			FROM user_portfolios p
			JOIN stocks s ON s.id = p.stock_id
			WHERE p.user_id = ANY(${userIds}::text[]) AND p.volume <> 0
			ORDER BY s.symbol
		`,
		sql`
			SELECT user_id, COALESCE(SUM(realized_pnl), 0)::float8 AS realized_pnl
			FROM closed_positions WHERE user_id = ANY(${userIds}::text[])
			GROUP BY user_id
		`,
	]);

	for (const row of userRows) {
		result.set(String(row.id), {
			cash_balance: Number(row.cash_balance),
			frozen_balance: Number(row.frozen_balance),
			realized_pnl: 0,
			positions: [],
		});
	}
	for (const row of realizedRows) {
		const inputs = result.get(String(row.user_id));
		if (inputs) inputs.realized_pnl = Number(row.realized_pnl);
	}
	for (const row of positionRows) {
		result.get(String(row.user_id))?.positions.push({
			stock_id: Number(row.stock_id),
			symbol: String(row.symbol),
			name: String(row.name),
			sector: String(row.sector),
			locked: Boolean(row.locked),
			volume: Number(row.volume),
			average_price: Number(row.average_price),
			margin_locked: Number(row.margin_locked),
			opened_at: row.opened_at
				? new Date(row.opened_at as string).toISOString()
				: null,
			stored_price: Number(row.stored_price),
		});
	}
	return result;
};

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
const pctOf = (part: number, whole: number) =>
	whole > 0 ? round2((part / whole) * 100) : 0;

/**
 * Open positions marked to the live price, plus the account totals. The one
 * place a portfolio is valued: the REST endpoint and the per-tick push both
 * come through here.
 *
 * net_worth = cash + frozen + long market value + short unrealized P&L.
 * A short counts only its P&L: the margin backing it is already inside
 * frozen_balance, and its proceeds were never credited.
 */
export const valuePortfolio = (
	inputs: PortfolioInputs,
	priceOf: (stockId: number) => number | undefined = getLivePrice,
): Portfolio => {
	const positions: Position[] = inputs.positions.map((row) => {
		const price = priceOf(row.stock_id) ?? row.stored_price;
		const quantity = Math.abs(row.volume);
		const isLong = row.volume > 0;
		const cost = row.average_price * quantity;
		const unrealized = isLong
			? (price - row.average_price) * quantity
			: (row.average_price - price) * quantity;
		return {
			stock_id: row.stock_id,
			symbol: row.symbol,
			name: row.name,
			sector: row.sector,
			side: isLong ? "long" : "short",
			volume: row.volume,
			quantity,
			average_price: row.average_price,
			last_price: price,
			market_value: round2(price * quantity),
			unrealized_pnl: round2(unrealized),
			unrealized_pnl_pct: cost > 0 ? round2((unrealized / cost) * 100) : 0,
			margin_locked: row.margin_locked,
			opened_at: row.opened_at,
			locked: row.locked,
		};
	});

	const cash = inputs.cash_balance;
	const frozen = inputs.frozen_balance;
	const longs = positions.filter((p) => p.side === "long");
	const shorts = positions.filter((p) => p.side === "short");

	const holdingsValue = sum(longs.map((p) => p.market_value));
	const shortExposure = sum(shorts.map((p) => p.market_value));
	const unrealizedPnl = sum(positions.map((p) => p.unrealized_pnl));
	const shortPnl = sum(shorts.map((p) => p.unrealized_pnl));
	const netWorth = cash + frozen + holdingsValue + shortPnl;
	const accountWhole = cash + frozen + holdingsValue;

	// Sectors by long market value, the tail folded into "Other", then cash.
	const bySector = new Map<string, number>();
	for (const p of longs) {
		bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + p.market_value);
	}
	const sectors = [...bySector]
		.filter(([, value]) => value > 0)
		.sort((a, b) => b[1] - a[1]);
	const head =
		sectors.length > ALLOCATION_SECTORS + 1
			? sectors.slice(0, ALLOCATION_SECTORS)
			: sectors;
	const tail = sectors.slice(head.length);
	const ringWhole = holdingsValue + Math.max(cash, 0);
	const slices: AllocationSlice[] = [
		...head.map(([label, value]) => ({
			label,
			kind: "sector" as const,
			value: round2(value),
			pct: pctOf(value, ringWhole),
		})),
		...(tail.length
			? [
					{
						label: "Other",
						kind: "other" as const,
						value: round2(sum(tail.map(([, value]) => value))),
						pct: pctOf(sum(tail.map(([, value]) => value)), ringWhole),
					},
				]
			: []),
		...(cash > 0
			? [
					{
						label: "Cash",
						kind: "cash" as const,
						value: round2(cash),
						pct: pctOf(cash, ringWhole),
					},
				]
			: []),
	];

	return {
		cash_balance: cash,
		frozen_balance: frozen,
		positions,
		totals: {
			invested: round2(sum(longs.map((p) => p.average_price * p.quantity))),
			holdings_value: round2(holdingsValue),
			short_exposure: round2(shortExposure),
			margin_used: round2(sum(shorts.map((p) => p.margin_locked))),
			gross_exposure: round2(holdingsValue + shortExposure),
			net_exposure: round2(holdingsValue - shortExposure),
			unrealized_pnl: round2(unrealizedPnl),
			realized_pnl: inputs.realized_pnl,
			net_worth: round2(netWorth),
			starting_capital: STARTING_CAPITAL,
			total_pnl: round2(netWorth - STARTING_CAPITAL),
			return_pct: round2(
				((netWorth - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
			),
			long_count: longs.length,
			short_count: shorts.length,
			cash_share_pct: pctOf(cash, accountWhole),
			frozen_share_pct: pctOf(frozen, accountWhole),
		},
		allocation: { slices, invested: round2(holdingsValue) },
		valued_at: new Date().toISOString(),
	};
};

const EMPTY_INPUTS: PortfolioInputs = {
	cash_balance: 0,
	frozen_balance: 0,
	realized_pnl: 0,
	positions: [],
};

export const getPortfolio = async (userId: string): Promise<Portfolio> => {
	const inputs = (await loadPortfolioInputs([userId])).get(userId);
	return valuePortfolio(inputs ?? EMPTY_INPUTS);
};
