/**
 * The Bazaar index and everything measured the same way: every stock against
 * its starting price. The index weights every stock equally, times 100, so 100
 * is where the market began; alongside it come each sector's average move and
 * the biggest movers.
 *
 * This is the only place these are calculated. The engine pushes a snapshot
 * after every tick ("indexTick") and the API serves the latest one, so the
 * player app and the admin panel display the same figures instead of each
 * working them out for themselves.
 */

import type { IndexSnapshot, MarketSector, MarketMover } from "./models/market.js";

export type IndexInput = {
	stockId: number;
	sector: string;
	price: number | null | undefined;
	startingPrice: number | null | undefined;
};

// How many gainers and losers the snapshot names.
const TOP_MOVERS = 5;

const round2 = (value: number) => Math.round(value * 100) / 100;

const usable = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/** A stock's move since its starting price, or null without both prices. */
export const sinceStart = (
	price: number | null | undefined,
	startingPrice: number | null | undefined,
): { change: number; change_pct: number } | null =>
	usable(price) && usable(startingPrice)
		? {
				change: round2(price - startingPrice),
				change_pct: ((price - startingPrice) / startingPrice) * 100,
			}
		: null;

export const computeIndexSnapshot = (
	stocks: IndexInput[],
	at: Date = new Date(),
): IndexSnapshot => {
	let total = 0;
	let advancing = 0;
	let declining = 0;
	let unchanged = 0;
	const moves: MarketMover[] = [];
	const bySector = new Map<string, { total: number; count: number; up: number; down: number }>();

	for (const { stockId, sector, price, startingPrice } of stocks) {
		const move = sinceStart(price, startingPrice);
		if (!move) continue;
		total += 1 + move.change_pct / 100;
		moves.push({ stock_id: stockId, change_pct: move.change_pct });
		if (move.change_pct > 0) advancing++;
		else if (move.change_pct < 0) declining++;
		else unchanged++;

		const entry = bySector.get(sector) ?? { total: 0, count: 0, up: 0, down: 0 };
		entry.total += move.change_pct;
		entry.count++;
		if (move.change_pct > 0) entry.up++;
		if (move.change_pct < 0) entry.down++;
		bySector.set(sector, entry);
	}

	const priced = moves.length;
	const level = priced ? (total / priced) * 100 : null;
	const ranked = [...moves].sort((a, b) => b.change_pct - a.change_pct);
	// Alphabetical, so a sector grid never reshuffles as prices move.
	const sectors: MarketSector[] = [...bySector]
		.map(([sector, entry]) => ({
			sector,
			change_pct: entry.total / entry.count,
			advancing: entry.up,
			declining: entry.down,
			stock_count: entry.count,
		}))
		.sort((a, b) => a.sector.localeCompare(b.sector));

	return {
		level,
		change_pct: level === null ? null : level - 100,
		advancing,
		declining,
		unchanged,
		priced_stocks: priced,
		sectors,
		// Split by sign, so a rising stock is never listed among the losers.
		top_gainers: ranked.filter((move) => move.change_pct > 0).slice(0, TOP_MOVERS),
		top_losers: ranked
			.filter((move) => move.change_pct < 0)
			.slice(-TOP_MOVERS)
			.reverse(),
		timestamp: at.toISOString(),
	};
};
