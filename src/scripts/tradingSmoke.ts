/**
 * Exercises the settlement function end to end against the real database:
 * buys, sells, a long->short flip, adding to a short, a partial cover, a
 * short->long flip, rejections, the margin invariant, and concurrent orders
 * racing for the same cash.
 *
 * Creates its own user and stock and deletes both (cascading) when done, so it
 * never touches real players or real stocks. Fills are placed at explicit
 * prices, so every expected number below can be checked by hand.
 *
 *   pnpm smoke:trading
 */
import { cancelAlert, createAlert } from "../controller/alerts.js";
import { updateIpoStatus } from "../controller/ipo.js";
import {
	applyForIpo,
	runIpoAllotment,
	withdrawIpoApplication,
} from "../controller/ipoApplications.js";
import {
	captureSnapshotsFor,
	getEquityCurve,
	getPnlSummary,
	getSectorAllocation,
} from "../controller/analytics.js";
import { getRankForUser } from "../controller/leaderboard.js";
import {
	addWatchlistItem,
	createWatchlist,
	deleteWatchlist,
	getWatchlists,
	removeWatchlistItem,
} from "../controller/watchlist.js";
import { checkAlerts, drainTriggeredAlerts } from "../trading/alerts.js";
import { toTradingError } from "../trading/errors.js";
import { getPortfolio } from "../controller/portfolio.js";
import sql from "../database/database.js";
import { initDB } from "../database/schema.js";
import type { FillResult } from "../models/order.js";
import {
	addRestingOrder,
	drainQueuedFills,
	matchTick,
} from "../trading/matcher.js";

const RUN = Date.now().toString(36);
const USER_ID = `smoke-${RUN}`;
const SYMBOL = `SM${RUN.slice(-6).toUpperCase()}`;
const STARTING_CASH = 10_000;

let stockId = 0;
let failures = 0;

const check = (label: string, actual: unknown, expected: unknown) => {
	const ok =
		typeof expected === "number"
			? Math.abs(Number(actual) - expected) < 0.005
			: actual === expected;
	if (!ok) failures++;
	console.log(
		`${ok ? "  ok  " : "  FAIL"} ${label}: ${String(actual)}${ok ? "" : ` (expected ${String(expected)})`}`,
	);
};

const order = async (side: "buy" | "sell", quantity: number, price: number) => {
	const rows = await sql`
		SELECT bazaar_place_market_order(${USER_ID}, ${stockId}, ${side}, ${quantity}, ${price}) AS result
	`;
	return rows[0].result as FillResult;
};

const expectRejected = async (
	label: string,
	code: string,
	run: () => Promise<unknown>,
) => {
	try {
		await run();
		failures++;
		console.log(`  FAIL ${label}: was accepted (expected ${code})`);
	} catch (error) {
		check(label, (error as Error).message, code);
	}
};

const account = async () => {
	const [user] = await sql`
		SELECT cash_balance::float8 AS cash, frozen_balance::float8 AS frozen
		FROM users WHERE id = ${USER_ID}
	`;
	const [position] = await sql`
		SELECT volume, average_price::float8 AS avg, margin_locked::float8 AS margin
		FROM user_portfolios WHERE user_id = ${USER_ID} AND stock_id = ${stockId}
	`;
	return {
		cash: user.cash as number,
		frozen: user.frozen as number,
		volume: position ? Number(position.volume) : 0,
		avg: position ? (position.avg as number) : 0,
		margin: position ? (position.margin as number) : 0,
	};
};

const expectAccount = async (
	step: string,
	expected: { cash: number; frozen: number; volume: number; avg: number; margin: number },
) => {
	const actual = await account();
	console.log(step);
	check("cash", actual.cash, expected.cash);
	check("frozen", actual.frozen, expected.frozen);
	check("volume", actual.volume, expected.volume);
	check("average price", actual.avg, expected.avg);
	check("margin locked", actual.margin, expected.margin);
	// frozen_balance must always equal everything it is holding.
	check("frozen == margin locked", actual.frozen, actual.margin);
};

const setup = async () => {
	await initDB();
	const [market] = await sql`SELECT is_paused FROM market WHERE id = 1`;
	if (market.is_paused) {
		throw new Error("The market is paused; resume it before running this.");
	}
	await sql`
		INSERT INTO users (id, name, email, "emailVerified", role, cash_balance, frozen_balance)
		VALUES (${USER_ID}, 'Smoke Test', ${`${USER_ID}@bazaar.test`}, TRUE, 'user', ${STARTING_CASH}, 0)
	`;
	const [stock] = await sql`
		INSERT INTO stocks (symbol, name, volatility, sector, last_price)
		VALUES (${SYMBOL}, 'Smoke Test Stock', 1, 'Test', 100)
		RETURNING id
	`;
	stockId = stock.id;
};

const cleanup = async () => {
	// Cascades to orders, positions, ledger rows, closed positions,
	// watchlists, alerts, snapshots and IPO applications.
	await sql`DELETE FROM users WHERE id IN (${USER_ID}, ${USER_B}, ${USER_C})`;
	await sql`DELETE FROM ipo WHERE symbol IN (${IPO_SYMBOL}, ${IPO2_SYMBOL})`;
	await sql`DELETE FROM stocks WHERE symbol IN (${SYMBOL}, ${IPO_SYMBOL})`;
};

const run = async () => {
	await setup();
	console.log(`user ${USER_ID}, stock ${SYMBOL} (#${stockId})\n`);

	await order("buy", 10, 100);
	await expectAccount("buy 10 @ 100", { cash: 9000, frozen: 0, volume: 10, avg: 100, margin: 0 });

	await order("buy", 10, 120);
	await expectAccount("buy 10 @ 120 (average up)", { cash: 7800, frozen: 0, volume: 20, avg: 110, margin: 0 });

	let fill = await order("sell", 5, 130);
	await expectAccount("sell 5 @ 130", { cash: 8450, frozen: 0, volume: 15, avg: 110, margin: 0 });
	check("realized (130-110)*5", fill.realized_pnl, 100);

	fill = await order("sell", 25, 100);
	await expectAccount("sell 25 @ 100 (sells 15, shorts 10)", {
		cash: 9450, frozen: 500, volume: -10, avg: 100, margin: 500,
	});
	check("fill legs", fill.fills.map((f) => `${f.transaction_type}:${f.quantity}`).join(","), "sell:15,short:10");
	check("realized (100-110)*15", fill.realized_pnl, -150);

	await order("sell", 10, 80);
	await expectAccount("sell 10 @ 80 (add to short)", {
		cash: 9050, frozen: 900, volume: -20, avg: 90, margin: 900,
	});

	fill = await order("buy", 5, 70);
	await expectAccount("buy 5 @ 70 (partial cover)", {
		cash: 9375, frozen: 675, volume: -15, avg: 90, margin: 675,
	});
	check("realized (90-70)*5", fill.realized_pnl, 100);

	// Mark-to-market with an open short: portfolio and leaderboard must agree.
	await sql`UPDATE stocks SET last_price = 85 WHERE id = ${stockId}`;
	const portfolio = await getPortfolio(USER_ID);
	const rank = await getRankForUser(USER_ID);
	console.log("valuation with a 15-share short at 90, price 85");
	// cash 9375 + frozen 675 + short P&L (90-85)*15 = 75
	check("portfolio net worth", portfolio.totals.net_worth, 10_125);
	check("leaderboard net worth", rank?.net_worth, 10_125);
	check("unrealized", portfolio.totals.unrealized_pnl, 75);
	check("realized so far", portfolio.totals.realized_pnl, 50);

	fill = await order("buy", 25, 60);
	await expectAccount("buy 25 @ 60 (covers 15, buys 10)", {
		cash: 9900, frozen: 0, volume: 10, avg: 60, margin: 0,
	});
	check("fill legs", fill.fills.map((f) => `${f.transaction_type}:${f.quantity}`).join(","), "cover:15,buy:10");
	check("realized (90-60)*15", fill.realized_pnl, 450);

	await order("sell", 10, 60);
	await expectAccount("sell 10 @ 60 (flat)", { cash: 10500, frozen: 0, volume: 0, avg: 0, margin: 0 });
	const [closed] = await sql`
		SELECT count(*)::int AS n, SUM(realized_pnl)::float8 AS total
		FROM closed_positions WHERE user_id = ${USER_ID}
	`;
	check("closed position rows", closed.n, 5);
	check("total realized = cash gained", closed.total, 500);

	console.log("rejections leave the account untouched");
	await expectRejected("buy beyond cash", "INSUFFICIENT_FUNDS", () => order("buy", 1000, 100));
	await expectRejected("short beyond margin", "INSUFFICIENT_MARGIN", () => order("sell", 1000, 100));
	await sql`UPDATE stocks SET locked = TRUE WHERE id = ${stockId}`;
	await expectRejected("locked stock", "STOCK_LOCKED", () => order("buy", 1, 100));
	await sql`UPDATE stocks SET locked = FALSE WHERE id = ${stockId}`;
	await expectAccount("after rejections", { cash: 10500, frozen: 0, volume: 0, avg: 0, margin: 0 });
	const [orphans] = await sql`
		SELECT count(*)::int AS n FROM orders WHERE user_id = ${USER_ID} AND status <> 'filled'
	`;
	check("no half-written orders from rejections", orphans.n, 0);

	console.log("20 concurrent buys of 15 @ 100 (1,500 each) against 10,000");
	await sql`UPDATE users SET cash_balance = ${STARTING_CASH} WHERE id = ${USER_ID}`;
	const results = await Promise.allSettled(
		Array.from({ length: 20 }, () => order("buy", 15, 100)),
	);
	const filled = results.filter((r) => r.status === "fulfilled").length;
	const refused = results.filter(
		(r) => r.status === "rejected" && (r.reason as Error).message === "INSUFFICIENT_FUNDS",
	).length;
	const reasons = new Map<string, number>();
	for (const r of results) {
		if (r.status === "rejected") {
			const e = r.reason as Error & { code?: string; detail?: string };
			const key = `${e.message} [${e.code ?? "no code"}] ${e.detail ?? ""}`.slice(0, 200);
			reasons.set(key, (reasons.get(key) ?? 0) + 1);
		}
	}
	for (const [reason, count] of reasons) console.log(`       ${count}x ${reason}`);
	check("filled", filled, 6);
	check("refused for funds", refused, 14);
	await expectAccount("after the race", { cash: 1000, frozen: 0, volume: 90, avg: 100, margin: 0 });

	await limitOrders();
	await watchlists();
	await alerts();
	await analytics();
	await ipos();
};

const USER_B = `${USER_ID}-b`;
const USER_C = `${USER_ID}-c`;
const IPO_SYMBOL = `IP${RUN.slice(-6).toUpperCase()}`;
const IPO2_SYMBOL = `IQ${RUN.slice(-6).toUpperCase()}`;

const createPlayer = async (id: string) => {
	await sql`
		INSERT INTO users (id, name, email, "emailVerified", role, cash_balance, frozen_balance)
		VALUES (${id}, ${id}, ${`${id}@bazaar.test`}, TRUE, 'user', ${STARTING_CASH}, 0)
	`;
};

const balances = async (id: string) => {
	const [row] = await sql`
		SELECT cash_balance::float8 AS cash, frozen_balance::float8 AS frozen FROM users WHERE id = ${id}
	`;
	return `${row.cash}/${row.frozen}`;
};

const createTestIpo = async (symbol: string) => {
	const [row] = await sql`
		INSERT INTO ipo (name, symbol, sector, open_date, close_date, allotment_date,
			lot_size, min_price, max_price, shares_offered, listing_price, status, is_open_to_subscription)
		VALUES ('Smoke Test IPO', ${symbol}, 'Test', NOW(), NOW(), NOW(),
			10, 90, 100, 100, 120, 'open', TRUE)
		RETURNING id
	`;
	return row.id as number;
};

const ipos = async () => {
	console.log("\nIPOs (10 lots of 10 shares, band 90-100, lists at 120)");
	await resetAccount();
	await sql`DELETE FROM user_stock_transactions WHERE user_id = ${USER_ID}`;
	await createPlayer(USER_B);
	await createPlayer(USER_C);
	const ipoId = await createTestIpo(IPO_SYMBOL);

	await applyForIpo(USER_ID, ipoId, 7, 100);
	await applyForIpo(USER_B, ipoId, 5, 100);
	await applyForIpo(USER_C, ipoId, 3, 90);
	check("A: 7 lots @ 100 blocks 7000", await balances(USER_ID), "3000/7000");
	check("applying twice", await errorCode(() => applyForIpo(USER_ID, ipoId, 1)), "ALREADY_APPLIED");
	check("bid outside the band", await errorCode(() => applyForIpo(USER_B, ipoId, 1, 150)), "INVALID_INPUT");

	await withdrawIpoApplication(USER_C, ipoId);
	check("C withdraws: refunded in full", await balances(USER_C), "10000/0");
	await applyForIpo(USER_C, ipoId, 3, 90);
	await checkFrozenReconciles();

	await updateIpoStatus(ipoId, "closed");
	check("applying after close", await errorCode(() => applyForIpo(USER_C, ipoId, 1)), "IPO_NOT_OPEN");
	check("listing before allotment", await errorCode(() => updateIpoStatus(ipoId, "listed", undefined, 1)), "ALLOTMENT_PENDING");

	const allotment = await runIpoAllotment(ipoId, 100);
	check("allottees", allotment.allottees, 2);
	// 12 eligible lots for 10: A 7*10/12 = 5.83, B 4.17 -> 5 + 4, leftover 1 to A.
	const apps = await sql`
		SELECT user_id, allotted_lots, status FROM ipo_applications WHERE ipo_id = ${ipoId}
	`;
	const byUser = (id: string) => apps.find((a) => a.user_id === id);
	check("A allotted (largest remainder)", `${byUser(USER_ID)?.allotted_lots} ${byUser(USER_ID)?.status}`, "6 partial");
	check("B allotted", `${byUser(USER_B)?.allotted_lots} ${byUser(USER_B)?.status}`, "4 partial");
	check("C bid 90 below the price", `${byUser(USER_C)?.allotted_lots} ${byUser(USER_C)?.status}`, "0 rejected");
	check("A: refund 1000, 6000 stays frozen", await balances(USER_ID), "4000/6000");
	check("B: refund 1000, 4000 stays frozen", await balances(USER_B), "6000/4000");
	check("C: refunded in full", await balances(USER_C), "10000/0");
	await checkFrozenReconciles();
	check("net worth does not dip before listing", (await getRankForUser(USER_ID))?.net_worth, 10_000);
	check("allotting twice", await errorCode(() => runIpoAllotment(ipoId, 100)), "ALLOTMENT_DONE");

	await updateIpoStatus(ipoId, "listed", undefined, 1);
	const [listed] = await sql`SELECT id FROM stocks WHERE symbol = ${IPO_SYMBOL}`;
	check("listing created the stock", Boolean(listed), true);
	const portfolioA = await getPortfolio(USER_ID);
	const holding = portfolioA.positions.find((p) => p.symbol === IPO_SYMBOL);
	check("A holds 60 shares", holding?.volume, 60);
	check("at the allotment price", holding?.average_price, 100);
	check("A frozen released into shares", await balances(USER_ID), "4000/0");
	check("A net worth with the listing gain (4000 + 60 x 120)", portfolioA.totals.net_worth, 11_200);

	console.log("withdrawn IPO refunds everyone");
	const ipo2 = await createTestIpo(IPO2_SYMBOL);
	await applyForIpo(USER_B, ipo2, 2);
	check("B blocked 2000 more at the default (top) price", await balances(USER_B), "4000/2000");
	await updateIpoStatus(ipo2, "withdrawn");
	check("B refunded", await balances(USER_B), "6000/0");
};

const analytics = async () => {
	console.log("\nanalytics");
	await resetAccount();
	await sql`DELETE FROM closed_positions WHERE user_id = ${USER_ID}`;
	await order("buy", 10, 100);
	await order("sell", 4, 110); // +40 realized
	await order("sell", 2, 95); // -10 realized
	await order("sell", 10, 100); // sells 4, shorts 6 @ 100
	await sql`UPDATE stocks SET last_price = 90 WHERE id = ${stockId}`;

	const portfolio = await getPortfolio(USER_ID);
	await captureSnapshotsFor([USER_ID]);
	const [snapshot] = await sql`
		SELECT net_worth::float8 AS net_worth, unrealized_pnl::float8 AS unrealized
		FROM portfolio_snapshots WHERE user_id = ${USER_ID} ORDER BY captured_at DESC LIMIT 1
	`;
	check("snapshot net worth matches the portfolio", snapshot.net_worth, portfolio.totals.net_worth);
	check("snapshot unrealized matches", snapshot.unrealized, portfolio.totals.unrealized_pnl);
	// short 6 @ 100 marked at 90
	check("short unrealized (100-90)*6", portfolio.totals.unrealized_pnl, 60);

	const curve = await getEquityCurve(USER_ID, 50);
	check("curve starts at starting capital", curve.points[0].net_worth, 500_000);
	check("curve ends at the live net worth", curve.points[curve.points.length - 1].net_worth, portfolio.totals.net_worth);
	check("curve points: start, snapshot, now", curve.points.length, 3);

	const summary = await getPnlSummary(USER_ID);
	check("closed slices", summary.closed_count, 3);
	check("wins", summary.win_count, 1);
	check("losses", summary.loss_count, 1);
	check("realized total", summary.realized_pnl, 30);
	check("best trade", summary.best_trade, 40);
	check("worst trade", summary.worst_trade, -10);

	const allocation = await getSectorAllocation(USER_ID);
	check("no longs, so no sector slices", allocation.sectors.length, 0);
	check("short exposure 6 x 90", allocation.short_exposure, 540);
};

// The code the API would answer with, for both TradingErrors and raw
// database errors raised by the settlement functions.
const errorCode = async (run: () => Promise<unknown>) => {
	try {
		await run();
		return "accepted";
	} catch (error) {
		return toTradingError(error).code;
	}
};

const watchlists = async () => {
	console.log("\nwatchlists");
	let lists = await getWatchlists(USER_ID);
	check("a first load creates a default list", lists.map((l) => l.name).join(","), "My Watchlist");

	await createWatchlist(USER_ID, "Tech");
	check("names are unique per player, ignoring case",
		await errorCode(() => createWatchlist(USER_ID, "tech")), "DUPLICATE_NAME");
	const tech = (await getWatchlists(USER_ID)).find((l) => l.name === "Tech");
	if (!tech) throw new Error("Tech watchlist missing");

	await addWatchlistItem(USER_ID, tech.id, stockId);
	await addWatchlistItem(USER_ID, tech.id, stockId);
	lists = await getWatchlists(USER_ID);
	check("adding the same stock twice keeps one",
		lists.find((l) => l.id === tech.id)?.items.length, 1);
	check("unknown stock", await errorCode(() => addWatchlistItem(USER_ID, tech.id, 99_999_999)), "STOCK_NOT_FOUND");
	check("another player's list is invisible",
		await errorCode(() => addWatchlistItem("someone-else", tech.id, stockId)), "WATCHLIST_NOT_FOUND");

	await removeWatchlistItem(USER_ID, tech.id, stockId);
	await deleteWatchlist(USER_ID, tech.id);
	lists = await getWatchlists(USER_ID);
	check("after removing and deleting", lists.map((l) => `${l.name}:${l.items.length}`).join(","), "My Watchlist:0");
};

const alertStatus = async (alertId: number) => {
	const [row] = await sql`SELECT status FROM price_alerts WHERE id = ${alertId}`;
	return row.status as string;
};

const alerts = async () => {
	console.log("\nprice alerts");
	await sql`UPDATE stocks SET last_price = 100 WHERE id = ${stockId}`;
	const above = await createAlert(USER_ID, { stock_id: stockId, target_price: 110 });
	const below = await createAlert(USER_ID, { stock_id: stockId, target_price: 90 });
	check("target over the price alerts above", above.direction, "above");
	check("target under the price alerts below", below.direction, "below");

	checkAlerts([{ stock_id: stockId, close_price: 105 }]);
	await drainTriggeredAlerts();
	check("105 fires neither", `${await alertStatus(above.id)},${await alertStatus(below.id)}`, "active,active");

	checkAlerts([{ stock_id: stockId, close_price: 111 }]);
	await drainTriggeredAlerts();
	check("111 fires the above alert only", `${await alertStatus(above.id)},${await alertStatus(below.id)}`, "triggered,active");
	checkAlerts([{ stock_id: stockId, close_price: 112 }]);
	await drainTriggeredAlerts();
	const [{ n }] = await sql`SELECT count(*)::int AS n FROM price_alerts WHERE id = ${above.id} AND status = 'triggered'`;
	check("it does not fire twice", n, 1);

	await cancelAlert(USER_ID, below.id);
	check("cancel", await alertStatus(below.id), "cancelled");
	check("cancel again", await errorCode(() => cancelAlert(USER_ID, below.id)), "ALERT_NOT_FOUND");

	// Crossed in memory, then cancelled in the database before the drain runs.
	const late = await createAlert(USER_ID, { stock_id: stockId, target_price: 120 });
	checkAlerts([{ stock_id: stockId, close_price: 125 }]);
	await sql`UPDATE price_alerts SET status = 'cancelled' WHERE id = ${late.id}`;
	await drainTriggeredAlerts();
	check("an alert cancelled mid-fire is not delivered", await alertStatus(late.id), "cancelled");
};

const resetAccount = async () => {
	await sql`DELETE FROM orders WHERE user_id = ${USER_ID}`;
	await sql`DELETE FROM user_portfolios WHERE user_id = ${USER_ID}`;
	await sql`UPDATE users SET cash_balance = ${STARTING_CASH}, frozen_balance = 0 WHERE id = ${USER_ID}`;
};

const limit = async (
	side: "buy" | "sell",
	quantity: number,
	limitPrice: number,
	currentPrice: number,
) => {
	const rows = await sql`
		SELECT bazaar_place_limit_order(
			${USER_ID}, ${stockId}, ${side}, ${quantity}, ${limitPrice}, ${currentPrice}
		) AS result
	`;
	return rows[0].result as { status: string; order_id: number; reserved_cash?: number; reserved_margin?: number };
};

const orderStatus = async (orderId: number) => {
	const [row] = await sql`SELECT status FROM orders WHERE id = ${orderId}`;
	return row.status as string;
};

// frozen_balance must equal everything it is holding: short margin, pending
// limit-order reservations and live IPO applications. Checked for every
// test player.
const checkFrozenReconciles = async () => {
	const rows = await sql`
		SELECT
			u.id,
			u.frozen_balance::float8 AS frozen,
			(COALESCE((SELECT SUM(margin_locked) FROM user_portfolios WHERE user_id = u.id), 0)
			 + COALESCE((SELECT SUM(reserved_cash + reserved_margin) FROM orders
			             WHERE user_id = u.id AND status = 'pending'), 0)
			 + COALESCE((SELECT SUM(amount_blocked - refund_amount) FROM ipo_applications
			             WHERE user_id = u.id AND status IN ('applied', 'allotted', 'partial')), 0)
			)::float8 AS held
		FROM users u WHERE u.id IN (${USER_ID}, ${USER_B}, ${USER_C})
	`;
	for (const row of rows) {
		check(`frozen reconciles (${String(row.id).slice(-2)})`, row.frozen, row.held);
	}
};

const limitOrders = async () => {
	console.log("\nlimit orders");
	await resetAccount();

	const resting = await limit("buy", 10, 90, 100);
	check("buy 10 @ 90 with price 100 rests", resting.status, "pending");
	check("reserved cash", resting.reserved_cash, 900);
	await checkFrozenReconciles();

	await sql`SELECT bazaar_release_order(${resting.order_id}, ${USER_ID}, 'cancelled', NULL)`;
	await expectAccount("cancelled: reservation returned", { cash: 10000, frozen: 0, volume: 0, avg: 0, margin: 0 });
	await expectRejected("cancelling twice", "ORDER_NOT_PENDING", () =>
		sql`SELECT bazaar_release_order(${resting.order_id}, ${USER_ID}, 'cancelled', NULL)`,
	);

	const marketable = await limit("buy", 10, 110, 100);
	check("buy 10 @ 110 with price 100 fills now", marketable.status, "filled");
	await expectAccount("filled at the better price, 100", { cash: 9000, frozen: 0, volume: 10, avg: 100, margin: 0 });

	const sellShort = await limit("sell", 20, 120, 100);
	check("sell 20 @ 120 rests", sellShort.status, "pending");
	check("reserves margin only for the 10 it would short", sellShort.reserved_margin, 600);
	await checkFrozenReconciles();

	await sql`SELECT bazaar_modify_order(${sellShort.order_id}, ${USER_ID}, 30, 130)`;
	const [modified] = await sql`
		SELECT quantity, limit_price::float8 AS limit_price, reserved_margin::float8 AS reserved_margin
		FROM orders WHERE id = ${sellShort.order_id}
	`;
	check("modified quantity", modified.quantity, 30);
	check("modified margin reservation (20 short @ 130)", modified.reserved_margin, 1300);
	await checkFrozenReconciles();

	console.log("matcher: the tick loop's book and drain");
	addRestingOrder({ id: sellShort.order_id, userId: USER_ID, stockId, side: "sell", limitPrice: 130 });
	matchTick([{ stock_id: stockId, close_price: 125 }]);
	await drainQueuedFills();
	check("not filled at 125", await orderStatus(sellShort.order_id), "pending");
	matchTick([{ stock_id: stockId, close_price: 131 }]);
	await drainQueuedFills();
	check("filled once the price crosses 130", await orderStatus(sellShort.order_id), "filled");
	// Reservation released, 10 sold at 130 (+1300), 20 shorted at 130 (margin 1300).
	await expectAccount("sold 10, shorted 20 at the limit", {
		cash: 9000, frozen: 1300, volume: -20, avg: 130, margin: 1300,
	});

	const cover = await limit("buy", 20, 140, 145);
	check("cover 20 @ 140 rests", cover.status, "pending");
	// Loss (140-130)*20 = 200 is less than the 1300 margin it frees.
	check("covering a short reserves nothing extra", cover.reserved_cash, 0);
	await sql`SELECT bazaar_release_order(${cover.order_id}, ${USER_ID}, 'cancelled', NULL)`;

	console.log("10 orders, each hit by a fill and a cancel at the same moment");
	await resetAccount();
	const ids: number[] = [];
	for (let i = 0; i < 10; i++) {
		ids.push((await limit("buy", 1, 50, 100)).order_id);
	}
	const outcomes = await Promise.allSettled(
		ids.flatMap((id) => [
			sql`SELECT bazaar_execute_fill(${id}, 50)`,
			sql`SELECT bazaar_release_order(${id}, ${USER_ID}, 'cancelled', NULL)`,
		]),
	);
	const unexpected = outcomes.filter(
		(o) => o.status === "rejected" && (o.reason as Error).message !== "ORDER_NOT_PENDING",
	);
	check("only losers of the race errored, as ORDER_NOT_PENDING", unexpected.length, 0);
	for (const o of unexpected) console.log("       ", (o as PromiseRejectedResult).reason.message);
	const statuses = await Promise.all(ids.map(orderStatus));
	const filledCount = statuses.filter((s) => s === "filled").length;
	const cancelledCount = statuses.filter((s) => s === "cancelled").length;
	check("every order ended filled or cancelled", filledCount + cancelledCount, 10);
	const after = await account();
	check("frozen back to 0", after.frozen, 0);
	check("shares = fills", after.volume, filledCount);
	check("cash = 10000 - 50 per fill", after.cash, STARTING_CASH - 50 * filledCount);
	console.log(`       (${filledCount} filled, ${cancelledCount} cancelled)`);
};

run()
	.catch((error) => {
		failures++;
		console.error("Smoke test crashed:", error);
	})
	.finally(async () => {
		await cleanup().catch((error) => console.error("Cleanup failed:", error));
		console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
		process.exit(failures === 0 ? 0 : 1);
	});
