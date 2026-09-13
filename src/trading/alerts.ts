import sql from "../database/database.js";
import { emitToUser } from "../realtime/emitter.js";

/**
 * Active price alerts, held in memory so the tick loop can check them for free,
 * the same way the matcher holds limit orders. Firing is a compare-and-swap on
 * status = 'active', so an alert cancelled while it was firing is never
 * delivered, and none fires twice.
 */
type ActiveAlert = {
	id: number;
	userId: string;
	stockId: number;
	targetPrice: number;
	direction: "above" | "below";
};

const byStock = new Map<number, ActiveAlert[]>();
const byId = new Map<number, ActiveAlert>();
// Alert id -> the price that crossed it, waiting for the drain.
const crossed = new Map<number, number>();

export const trackAlert = (alert: ActiveAlert) => {
	untrackAlert(alert.id);
	const list = byStock.get(alert.stockId) ?? [];
	list.push(alert);
	byStock.set(alert.stockId, list);
	byId.set(alert.id, alert);
};

export const untrackAlert = (alertId: number) => {
	const alert = byId.get(alertId);
	if (!alert) return;
	byId.delete(alertId);
	crossed.delete(alertId);
	const list = byStock.get(alert.stockId);
	if (!list) return;
	const remaining = list.filter((existing) => existing.id !== alertId);
	if (remaining.length > 0) {
		byStock.set(alert.stockId, remaining);
	} else {
		byStock.delete(alert.stockId);
	}
};

export const loadActiveAlerts = async () => {
	const rows = await sql`
		SELECT id::int AS id, user_id, stock_id, target_price::float8 AS target_price, direction
		FROM price_alerts WHERE status = 'active'
	`;
	byStock.clear();
	byId.clear();
	crossed.clear();
	for (const row of rows) {
		trackAlert({
			id: row.id,
			userId: row.user_id,
			stockId: row.stock_id,
			targetPrice: row.target_price,
			direction: row.direction,
		});
	}
	console.info(`Loaded ${rows.length} active price alerts.`);
};

/** Called by the engine after every tick. In-memory only. */
export const checkAlerts = (
	prices: { stock_id: number; close_price: number }[],
) => {
	for (const { stock_id: stockId, close_price: price } of prices) {
		const list = byStock.get(stockId);
		if (!list) continue;
		for (const alert of list) {
			const hit =
				alert.direction === "above"
					? price >= alert.targetPrice
					: price <= alert.targetPrice;
			if (hit && !crossed.has(alert.id)) {
				crossed.set(alert.id, price);
			}
		}
	}
};

let isDraining = false;

/** Marks every crossed alert triggered in one statement and notifies owners. */
export const drainTriggeredAlerts = async () => {
	if (isDraining || crossed.size === 0) return;
	isDraining = true;
	const batch = [...crossed];
	try {
		const ids = batch.map(([id]) => id);
		const prices = batch.map(([, price]) => price);
		const fired = await sql`
			WITH fired AS (
				UPDATE price_alerts a
				SET status = 'triggered', triggered_at = CURRENT_TIMESTAMP, triggered_price = t.price
				FROM UNNEST(${ids}::bigint[], ${prices}::numeric[]) AS t(id, price)
				WHERE a.id = t.id AND a.status = 'active'
				RETURNING a.id, a.user_id, a.stock_id, a.target_price, a.direction, a.note,
					a.triggered_price, a.triggered_at
			)
			SELECT
				f.id::int AS id, f.user_id, f.stock_id, s.symbol, s.name,
				f.target_price::float8 AS target_price, f.direction, f.note,
				f.triggered_price::float8 AS triggered_price, f.triggered_at
			FROM fired f JOIN stocks s ON s.id = f.stock_id
		`;
		for (const alert of fired) {
			emitToUser(alert.user_id, "priceAlertTriggered", alert);
		}
		// Whether it fired now or was cancelled meanwhile, it is no longer active.
		for (const id of ids) untrackAlert(id);
	} finally {
		isDraining = false;
	}
};
