import sql from "../database/database.js";
import type { Ipo, IpoStatus } from "../models/ipo.js";
import { TradingError } from "../trading/errors.js";
import { listIpo, refundAllApplications } from "./ipoApplications.js";

// Live subscription: shares applied for over shares offered. Falls back to the
// admin-entered value for IPOs nobody has applied to.
const SUBSCRIPTION_RATE = sql`
	COALESCE(
		(SELECT SUM(a.lots * a.lot_size) FROM ipo_applications a
		 WHERE a.ipo_id = ipo.id AND a.status <> 'withdrawn')::float8 / NULLIF(ipo.shares_offered, 0),
		ipo.subscription_rate::float8
	) AS subscription_rate
`;

type GetAllIpoFilters = {
	status?: IpoStatus;
	sector?: string;
	symbol?: string;
	is_open_to_subscription?: boolean;
	includeDormant?: boolean;
};

export const getAllIpos = async (filters?: GetAllIpoFilters) => {
	const status = filters?.status ?? null;
	const sector = filters?.sector ?? null;
	const symbol = filters?.symbol ?? null;
	const isOpenToSubscription = filters?.is_open_to_subscription ?? null;
	const includeDormant = filters?.includeDormant ?? false;

	const result = await sql`
		SELECT
			id,
			name,
			symbol,
			close_date,
			open_date,
			allotment_date,
			${SUBSCRIPTION_RATE},
			sector,
			is_open_to_subscription,
			lot_size,
			max_price,
			min_price,
			status,
			shares_offered,
			-- Whole lots on offer, and one lot's cost at the top of the band.
			(shares_offered / NULLIF(lot_size, 0))::int AS lots_offered,
			(lot_size * max_price)::float8 AS lot_value_at_max,
			listing_price,
			allotment_price,
			allotment_completed_at,
			listed_stock_id,
			created_at,
			updated_at
		FROM ipo
		WHERE
			(${includeDormant}::boolean = TRUE OR status <> 'dormant')
			AND
			(${status}::text IS NULL OR status = ${status})
			AND (${sector}::text IS NULL OR LOWER(sector) = LOWER(${sector}))
			AND (${symbol}::text IS NULL OR LOWER(symbol) = LOWER(${symbol}))
			AND (${isOpenToSubscription}::boolean IS NULL OR is_open_to_subscription = ${isOpenToSubscription})
		ORDER BY open_date DESC, created_at DESC
	`;
	return result as Ipo[];
};

export const getIpoById = async (id: number, includeDormant = false) => {
	const result = await sql`
		SELECT
			id,
			name,
			symbol,
			close_date,
			open_date,
			allotment_date,
			${SUBSCRIPTION_RATE},
			sector,
			is_open_to_subscription,
			lot_size,
			max_price,
			min_price,
			status,
			shares_offered,
			listing_price,
			allotment_price,
			allotment_completed_at,
			listed_stock_id,
			created_at,
			updated_at
		FROM ipo
		WHERE
			id = ${id}
			AND (${includeDormant}::boolean = TRUE OR status <> 'dormant')
	`;
	return result[0] as Ipo | undefined;
};

export const addIpo = async (
	ipoData: Omit<Ipo, "id" | "created_at" | "updated_at">,
) => {
	const {
		name,
		symbol,
		close_date,
		open_date,
		allotment_date,
		subscription_rate,
		sector,
		is_open_to_subscription,
		lot_size,
		max_price,
		min_price,
		status,
		shares_offered,
		listing_price,
	} = ipoData;

	await sql`
		INSERT INTO ipo (
			name,
			symbol,
			close_date,
			open_date,
			allotment_date,
			${SUBSCRIPTION_RATE},
			sector,
			is_open_to_subscription,
			lot_size,
			max_price,
			min_price,
			status,
			shares_offered,
			listing_price
		)
		VALUES (
			${name},
			${symbol},
			${close_date},
			${open_date},
			${allotment_date},
			${subscription_rate},
			${sector},
			${is_open_to_subscription},
			${lot_size},
			${max_price},
			${min_price},
			${status},
			${shares_offered},
			${listing_price}
		)
	`;
};

export const updateIpo = async (
	id: number,
	ipoData: Partial<Omit<Ipo, "id" | "created_at">>,
) => {
	const hasUpdates =
		ipoData.name !== undefined ||
		ipoData.symbol !== undefined ||
		ipoData.close_date !== undefined ||
		ipoData.open_date !== undefined ||
		ipoData.allotment_date !== undefined ||
		ipoData.subscription_rate !== undefined ||
		ipoData.sector !== undefined ||
		ipoData.is_open_to_subscription !== undefined ||
		ipoData.lot_size !== undefined ||
		ipoData.max_price !== undefined ||
		ipoData.min_price !== undefined ||
		ipoData.status !== undefined ||
		ipoData.shares_offered !== undefined ||
		ipoData.listing_price !== undefined;

	if (!hasUpdates) {
		return;
	}

	await sql`
		UPDATE ipo
		SET
			name = COALESCE(${ipoData.name ?? null}, name),
			symbol = COALESCE(${ipoData.symbol ?? null}, symbol),
			close_date = COALESCE(${ipoData.close_date ?? null}, close_date),
			open_date = COALESCE(${ipoData.open_date ?? null}, open_date),
			allotment_date = COALESCE(${ipoData.allotment_date ?? null}, allotment_date),
			subscription_rate = COALESCE(${ipoData.subscription_rate ?? null}, subscription_rate),
			sector = COALESCE(${ipoData.sector ?? null}, sector),
			is_open_to_subscription = COALESCE(${ipoData.is_open_to_subscription ?? null}, is_open_to_subscription),
			lot_size = COALESCE(${ipoData.lot_size ?? null}, lot_size),
			max_price = COALESCE(${ipoData.max_price ?? null}, max_price),
			min_price = COALESCE(${ipoData.min_price ?? null}, min_price),
			shares_offered = COALESCE(${ipoData.shares_offered ?? null}, shares_offered),
			listing_price = COALESCE(${ipoData.listing_price ?? null}, listing_price),
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ${id}
	`;

	// Status changes move money (listing credits shares, withdrawal refunds),
	// so they always go through updateIpoStatus, never a plain column update.
	if (ipoData.status !== undefined) {
		await updateIpoStatus(id, ipoData.status);
	}
};

/**
 * Moving to "listed" creates the stock and credits every allotment as shares
 * (bazaar_list_ipo), and is refused until allotment has run. Moving to
 * "withdrawn" refunds every live application. Other statuses are plain updates.
 */
export const updateIpoStatus = async (
	id: number,
	status: Ipo["status"],
	isOpenToSubscription?: boolean,
	volatility?: number,
) => {
	const ipoResult = await sql`SELECT status FROM ipo WHERE id = ${id}`;
	const current = ipoResult[0] as Pick<Ipo, "status"> | undefined;
	if (!current) {
		throw new TradingError("IPO_NOT_FOUND", "IPO not found.");
	}

	if (status === "listed") {
		if (current.status !== "listed") {
			await listIpo(id, volatility);
		}
		return;
	}

	await sql`
		UPDATE ipo
		SET
			status = ${status},
			is_open_to_subscription = COALESCE(${isOpenToSubscription ?? null}, is_open_to_subscription),
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ${id}
	`;

	if (status === "withdrawn") {
		await refundAllApplications(id);
	}
};

/** Refunds applications first: deleting cascades to them and their held cash. */
export const deleteIpo = async (id: number) => {
	await refundAllApplications(id);
	await sql`DELETE FROM ipo WHERE id = ${id}`;
};
