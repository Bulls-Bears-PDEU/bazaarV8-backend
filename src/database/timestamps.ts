import { types as neonTypes } from "@neondatabase/serverless";
import pg from "pg";

/**
 * Every TIMESTAMP column holds UTC: the database runs in UTC and the app writes
 * ISO strings. The drivers read a TIMESTAMP (it has no zone) as the server's
 * local time, so on a machine outside UTC every date came back shifted, by five
 * and a half hours in India, and stored candles plotted hours away from live
 * ones. Reading them as UTC is what the values mean, and changes nothing on a
 * server that already runs in UTC.
 */
const TIMESTAMP_OID = 1114;

const parseUtcTimestamp = (value: string) => {
	// "infinity", "-infinity" and BC dates are passed through untouched.
	if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
		return value;
	}
	return new Date(`${value.replace(" ", "T")}Z`);
};

neonTypes.setTypeParser(TIMESTAMP_OID, parseUtcTimestamp);
pg.types.setTypeParser(TIMESTAMP_OID, parseUtcTimestamp);
// And the other way: a Date written through the pool is sent as UTC, so it
// lands in a TIMESTAMP column as the same UTC wall time it is read back as.
// TIMESTAMPTZ columns (Better Auth's) store the same instant either way.
pg.defaults.parseInputDatesAsUTC = true;
