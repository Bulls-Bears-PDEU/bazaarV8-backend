import sql from "../database/database.js";
import { trackAlert, untrackAlert } from "../trading/alerts.js";
import { pgErrorCode, TradingError } from "../trading/errors.js";
import { getFillPrice } from "../trading/pricing.js";

const MAX_ACTIVE_ALERTS = 50;
const ALERT_STATUSES = ["active", "triggered", "cancelled"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const parseAlertStatus = (value: unknown): AlertStatus | undefined =>
	ALERT_STATUSES.find((status) => status === value);

const ALERT_COLUMNS = sql`
	a.id::int AS id, a.stock_id, s.symbol, s.name,
	a.target_price::float8 AS target_price, a.direction,
	a.baseline_price::float8 AS baseline_price, a.note, a.status,
	a.created_at, a.triggered_at, a.triggered_price::float8 AS triggered_price
`;

export const getAlerts = async (userId: string, status?: AlertStatus) => {
	return sql`
		SELECT ${ALERT_COLUMNS}
		FROM price_alerts a JOIN stocks s ON s.id = a.stock_id
		WHERE a.user_id = ${userId}
			AND (${status ?? null}::text IS NULL OR a.status = ${status ?? null}::text)
		ORDER BY a.created_at DESC
		LIMIT 200
	`;
};

/**
 * Without a direction, the alert fires when the price reaches the target from
 * where it is now: above if the target is higher, below if it is lower.
 */
export const createAlert = async (
	userId: string,
	input: {
		stock_id: number;
		target_price: number;
		direction?: "above" | "below";
		note?: string;
	},
) => {
	const baseline = (await getFillPrice(input.stock_id)) ?? null;
	const direction =
		input.direction ??
		(baseline === null
			? undefined
			: input.target_price >= baseline
				? "above"
				: "below");
	if (!direction) {
		throw new TradingError(
			"INVALID_INPUT",
			"This stock has no price yet, so say whether to alert above or below.",
		);
	}

	const [{ active }] = await sql`
		SELECT count(*)::int AS active FROM price_alerts
		WHERE user_id = ${userId} AND status = 'active'
	`;
	if (active >= MAX_ACTIVE_ALERTS) {
		throw new TradingError(
			"LIMIT_REACHED",
			`You can have at most ${MAX_ACTIVE_ALERTS} active alerts.`,
		);
	}

	let rows: Record<string, unknown>[];
	try {
		rows = await sql`
			WITH created AS (
				INSERT INTO price_alerts (user_id, stock_id, target_price, direction, baseline_price, note)
				VALUES (${userId}, ${input.stock_id}, ${input.target_price}, ${direction},
					${baseline}, ${input.note ?? null})
				RETURNING *
			)
			SELECT ${ALERT_COLUMNS} FROM created a JOIN stocks s ON s.id = a.stock_id
		`;
	} catch (error) {
		if (pgErrorCode(error) === "23503") {
			throw new TradingError("STOCK_NOT_FOUND", "Stock not found.");
		}
		throw error;
	}

	const alert = rows[0] as {
		id: number;
		target_price: number;
		direction: "above" | "below";
	};
	trackAlert({
		id: alert.id,
		userId,
		stockId: input.stock_id,
		targetPrice: alert.target_price,
		direction: alert.direction,
	});
	return alert;
};

export const cancelAlert = async (userId: string, alertId: number) => {
	const rows = await sql`
		UPDATE price_alerts SET status = 'cancelled'
		WHERE id = ${alertId} AND user_id = ${userId} AND status = 'active'
		RETURNING id::int AS id, status
	`;
	if (rows.length === 0) {
		throw new TradingError(
			"ALERT_NOT_FOUND",
			"No active alert with that id. It may have already fired.",
		);
	}
	untrackAlert(alertId);
	return rows[0];
};
