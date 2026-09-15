import pg from "pg";
import config from "../config/config.js";
// Before any query runs: TIMESTAMP columns hold UTC.
import "./timestamps.js";

// pg hands NUMERIC back as a string to avoid precision loss. Money here is
// NUMERIC(15,2) and stays well inside a double's exact range, so parse it once
// globally rather than at every call site. This also covers Better Auth, which
// shares this pool, so session.user.cash_balance arrives as a number.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) =>
	value === null ? null : Number.parseFloat(value),
);

/**
 * TCP pool for everything that needs a real transaction. The neon() HTTP driver
 * in database.ts only runs non-interactive batches, so it cannot read a
 * balance and then write based on it. Reads keep using that driver.
 *
 * Neon's "-pooler" endpoint is PgBouncer in transaction mode: BEGIN/COMMIT and
 * SELECT ... FOR UPDATE work, session-scoped features (pg_advisory_lock,
 * prepared statements across transactions) do not. Use pg_advisory_xact_lock.
 */
export const pool = new pg.Pool({
	connectionString: config.TRADING_DATABASE_URL,
	max: 10,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
	// An idle client dropped by the server must not crash the process.
	console.error("Idle pg client error:", err);
});

export type PoolClient = pg.PoolClient;

export const withTransaction = async <T>(
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
};
