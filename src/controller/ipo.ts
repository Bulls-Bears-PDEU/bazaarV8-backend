import sql from "../database/database.js";
import type { Ipo, IpoStatus } from "../models/ipo.js";

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
			subscription_rate,
			sector,
			is_open_to_subscription,
			lot_size,
			max_price,
			min_price,
			status,
			shares_offered,
			listing_price,
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
			subscription_rate,
			sector,
			is_open_to_subscription,
			lot_size,
			max_price,
			min_price,
			status,
			shares_offered,
			listing_price,
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
			subscription_rate,
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
			status = COALESCE(${ipoData.status ?? null}, status),
			shares_offered = COALESCE(${ipoData.shares_offered ?? null}, shares_offered),
			listing_price = COALESCE(${ipoData.listing_price ?? null}, listing_price),
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ${id}
	`;
};

export const updateIpoStatus = async (
	id: number,
	status: Ipo["status"],
	isOpenToSubscription?: boolean,
	volatility?: number,
) => {
	// First get the IPO data to check current status
	const ipoResult = await sql`
		SELECT * FROM ipo WHERE id = ${id}
	`;
	const ipo = ipoResult[0] as Ipo | undefined;

	if (!ipo) {
		throw new Error("IPO not found");
	}

	// Update IPO status
	await sql`
		UPDATE ipo
		SET
			status = ${status},
			is_open_to_subscription = COALESCE(${isOpenToSubscription ?? null}, is_open_to_subscription),
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ${id}
	`;

	// If status is changing to "listed", create a stock record
	if (status === "listed" && ipo.status !== "listed") {
		await addStockFromListing(ipo, volatility ?? 0);
	}
};

/**
 * Helper function to create a stock record when an IPO is listed
 * Checks for duplicate symbols and creates stock entry
 */
const addStockFromListing = async (ipo: Ipo, volatility: number) => {
	// Check if stock already exists with this symbol
	const existingStock = await sql`
		SELECT id FROM stocks WHERE symbol = ${ipo.symbol}
	`;

	if (existingStock.length > 0) {
		// Stock already exists, skip creation
		console.log(`Stock with symbol ${ipo.symbol} already exists`);
		return;
	}

	// Create new stock from IPO listing
	const newStock = await sql`
		INSERT INTO stocks (name, symbol, sector, volatility, locked)
		VALUES (
			${ipo.name},
			${ipo.symbol},
			${ipo.sector},
			${volatility},
			FALSE
		)
		RETURNING id
	`;

	const stockId = newStock[0].id;

	// Insert initial price into stock_ohlc using IPO's listing price
	await sql`
		INSERT INTO stock_ohlc (
			stock_id, 
			open_price, 
			high_price, 
			low_price, 
			close_price
		)
		VALUES (
			${stockId},
			${ipo.listing_price},
			${ipo.listing_price},
			${ipo.listing_price},
			${ipo.listing_price}
		)
	`;

	console.log(`Stock created from IPO listing: ${ipo.symbol} with initial price ${ipo.listing_price}`);
};

export const deleteIpo = async (id: number) => {
	await sql`DELETE FROM ipo WHERE id = ${id}`;
};
