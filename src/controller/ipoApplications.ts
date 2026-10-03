import sql from "../database/database.js";
import eventEmitter from "../eventEmitter.js";
import { emitToMarket, emitToUser } from "../realtime/emitter.js";

/**
 * All money movement happens inside the bazaar_*_ipo functions (see
 * migrateIpoApplications in database/schema.ts); these are thin wrappers that
 * tell the affected players' sockets what changed.
 */

type ApplyResult = {
	application_id: number;
	ipo_id: number;
	cash_balance: number;
	frozen_balance: number;
};

export const applyForIpo = async (
	userId: string,
	ipoId: number,
	lots: number,
	bidPrice?: number,
) => {
	const rows = await sql`
		SELECT bazaar_apply_ipo(${userId}, ${ipoId}, ${lots}, ${bidPrice ?? null}) AS result
	`;
	const result = rows[0].result as ApplyResult;
	emitToUser(userId, "ipoApplicationUpdate", result);
	emitToUser(userId, "walletUpdate", {
		cash_balance: result.cash_balance,
		frozen_balance: result.frozen_balance,
	});
	return result;
};

export const withdrawIpoApplication = async (userId: string, ipoId: number) => {
	const rows = await sql`
		SELECT bazaar_withdraw_ipo_applications(${ipoId}, ${userId}) AS result
	`;
	const result = rows[0].result;
	emitToUser(userId, "ipoApplicationUpdate", { ipo_id: ipoId, status: "withdrawn" });
	return result;
};

const APPLICATION_COLUMNS = sql`
	a.id::int AS id, a.ipo_id, i.name, i.symbol, i.status AS ipo_status,
	a.lots, a.lot_size, a.bid_price::float8 AS bid_price,
	a.amount_blocked::float8 AS amount_blocked,
	a.allotted_lots, a.allotment_price::float8 AS allotment_price,
	a.refund_amount::float8 AS refund_amount,
	CASE WHEN a.status IN ('applied', 'allotted', 'partial')
		THEN (a.amount_blocked - a.refund_amount)::float8 ELSE 0 END AS amount_held,
	a.status, a.created_at, a.updated_at, i.allotment_date, i.listed_stock_id
`;

export const getMyApplications = async (userId: string) => {
	return sql`
		SELECT ${APPLICATION_COLUMNS}
		FROM ipo_applications a JOIN ipo i ON i.id = a.ipo_id
		WHERE a.user_id = ${userId}
		ORDER BY a.created_at DESC
	`;
};

export const getIpoApplicationsAdmin = async (ipoId: number) => {
	const [applications, [summary]] = await Promise.all([
		sql`
			SELECT ${APPLICATION_COLUMNS}, a.user_id, u.name AS user_name, u.email AS user_email
			FROM ipo_applications a
			JOIN ipo i ON i.id = a.ipo_id
			JOIN users u ON u.id = a.user_id
			WHERE a.ipo_id = ${ipoId}
			ORDER BY a.created_at
		`,
		sql`
			SELECT
				count(*) FILTER (WHERE a.status <> 'withdrawn')::int AS applications,
				COALESCE(SUM(a.lots) FILTER (WHERE a.status <> 'withdrawn'), 0)::int AS lots_applied,
				(i.shares_offered / i.lot_size)::int AS lots_offered,
				(COALESCE(SUM(a.lots * a.lot_size) FILTER (WHERE a.status <> 'withdrawn'), 0)::float8
					/ NULLIF(i.shares_offered, 0)) AS subscription_rate
			FROM ipo i LEFT JOIN ipo_applications a ON a.ipo_id = i.id
			WHERE i.id = ${ipoId}
			GROUP BY i.id
		`,
	]);
	return { applications, summary: summary ?? null };
};

type AllotmentResult = { ipo_id: number; allottees: number; refunded: number };

export const runIpoAllotment = async (ipoId: number, allotmentPrice?: number) => {
	const rows = await sql`
		SELECT bazaar_run_ipo_allotment(${ipoId}, ${allotmentPrice ?? null}) AS result
	`;
	const result = rows[0].result as AllotmentResult;
	await notifyApplicants(ipoId, "ipoAllotmentResult");
	return result;
};

/**
 * Credits allotments as shares and starts the stock trading. Called by
 * updateIpoStatus when an admin moves an IPO to "listed".
 */
export const listIpo = async (ipoId: number, volatility?: number) => {
	const rows = await sql`
		SELECT bazaar_list_ipo(${ipoId}, ${volatility ?? null}) AS result
	`;
	eventEmitter.emit("stocksChanged");
	// The new stock appears in both apps' stock lists, and the IPO moves to
	// "listed", without anyone reloading.
	emitToMarket("stocksChanged", { id: rows[0].result?.stock_id });
	emitToMarket("iposChanged", { id: ipoId });
	await notifyApplicants(ipoId, "ipoApplicationUpdate");
	return rows[0].result;
};

/** Refunds every live application. Called when an IPO is withdrawn. */
export const refundAllApplications = async (ipoId: number) => {
	const rows = await sql`
		SELECT bazaar_withdraw_ipo_applications(${ipoId}, NULL) AS result
	`;
	await notifyApplicants(ipoId, "ipoApplicationUpdate");
	return rows[0].result;
};

const notifyApplicants = async (ipoId: number, event: string) => {
	const rows = await sql`
		SELECT ${APPLICATION_COLUMNS}, a.user_id,
			u.cash_balance::float8 AS cash_balance, u.frozen_balance::float8 AS frozen_balance
		FROM ipo_applications a
		JOIN ipo i ON i.id = a.ipo_id
		JOIN users u ON u.id = a.user_id
		WHERE a.ipo_id = ${ipoId}
	`;
	for (const row of rows) {
		emitToUser(row.user_id, event, row);
		emitToUser(row.user_id, "walletUpdate", {
			cash_balance: row.cash_balance,
			frozen_balance: row.frozen_balance,
		});
	}
};
