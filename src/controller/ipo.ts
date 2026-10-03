import sql from "../database/database.js";
import type { Ipo, IpoStatus } from "../models/ipo.js";
import { emitToMarket } from "../realtime/emitter.js";
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
		-- NUMERIC and BIGINT arrive as strings from the driver; cast so the apps
		-- get the numbers the Ipo type promises (formatINR shows "—" for a string).
		SELECT
			id,
			name,
			symbol,
			close_date,
			open_date,
			allotment_date,
			${SUBSCRIPTION_RATE},
			-- What the organiser entered, shown until the first application.
			subscription_rate::float8 AS starting_demand,
			sector,
			is_open_to_subscription,
			lot_size,
			max_price::float8 AS max_price,
			min_price::float8 AS min_price,
			status,
			shares_offered::float8 AS shares_offered,
			-- Whole lots on offer, and one lot's cost at the top of the band.
			(shares_offered / NULLIF(lot_size, 0))::int AS lots_offered,
			(lot_size * max_price)::float8 AS lot_value_at_max,
			listing_price::float8 AS listing_price,
			allotment_price::float8 AS allotment_price,
			allotment_completed_at,
			listed_stock_id,
			logo_url,
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
			-- What the organiser entered, shown until the first application.
			subscription_rate::float8 AS starting_demand,
			sector,
			is_open_to_subscription,
			lot_size,
			max_price::float8 AS max_price,
			min_price::float8 AS min_price,
			status,
			shares_offered::float8 AS shares_offered,
			listing_price::float8 AS listing_price,
			allotment_price::float8 AS allotment_price,
			allotment_completed_at,
			listed_stock_id,
			logo_url,
			created_at,
			updated_at
		FROM ipo
		WHERE
			id = ${id}
			AND (${includeDormant}::boolean = TRUE OR status <> 'dormant')
	`;
	return result[0] as Ipo | undefined;
};

// An IPO can start as a draft, announced or already open. Closed and listed
// are reached through the lifecycle: listing creates the stock and credits
// allotments, which a plain insert would skip.
const CREATABLE_STATUSES: IpoStatus[] = ["dormant", "upcoming", "open"];

// stocks.symbol is VARCHAR(10), and the IPO becomes a stock on listing.
const MAX_SYMBOL_LENGTH = 10;

export type NewIpo = Omit<
	Ipo,
	| "id"
	| "created_at"
	| "updated_at"
	| "lots_offered"
	| "lot_value_at_max"
	| "allotment_price"
	| "allotment_completed_at"
	| "listed_stock_id"
	| "logo_url"
>;

type IpoFields = Omit<NewIpo, "status" | "is_open_to_subscription">;

/**
 * Checks and normalises an IPO's details, so a bad form gets a sentence saying
 * what is wrong instead of a database error. Shared by create and edit.
 */
const parseIpoFields = (body: unknown): IpoFields => {
	const input = (body ?? {}) as Record<string, unknown>;
	const fail = (message: string): never => {
		throw new TradingError("INVALID_INPUT", message);
	};
	const text = (key: string, label: string) => {
		const value = typeof input[key] === "string" ? input[key].trim() : "";
		if (!value) fail(`${label} is required.`);
		return value;
	};
	const number = (key: string, label: string, fallback?: number) => {
		const raw = input[key];
		if ((raw === undefined || raw === null || raw === "") && fallback !== undefined)
			return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value) || value < 0) fail(`${label} must be a number, zero or more.`);
		return value;
	};
	const date = (key: string, label: string) => {
		const value = new Date(text(key, label));
		if (Number.isNaN(value.getTime())) fail(`${label} is not a valid date.`);
		return value;
	};

	const name = text("name", "Company name");
	const symbol = text("symbol", "Symbol").toUpperCase();
	if (!/^[A-Z0-9&-]+$/.test(symbol))
		fail("Symbol can use letters, digits, & and - only.");
	if (symbol.length > MAX_SYMBOL_LENGTH)
		fail(`Symbol can be at most ${MAX_SYMBOL_LENGTH} characters.`);
	const sector = text("sector", "Sector");

	const minPrice = number("min_price", "Minimum price");
	const maxPrice = number("max_price", "Maximum price");
	if (minPrice <= 0) fail("Minimum price must be above zero.");
	if (maxPrice < minPrice) fail("Maximum price cannot be below the minimum price.");

	const lotSize = number("lot_size", "Lot size");
	const sharesOffered = number("shares_offered", "Shares offered");
	if (!Number.isInteger(lotSize) || lotSize < 1) fail("Lot size must be a whole number of shares, 1 or more.");
	if (!Number.isInteger(sharesOffered) || sharesOffered < lotSize)
		fail("Shares offered must be a whole number, at least one lot.");

	const listingPrice = number("listing_price", "Listing price", 0);
	const subscriptionRate = number("subscription_rate", "Subscription rate", 0);

	const openDate = date("open_date", "Open date");
	const closeDate = date("close_date", "Close date");
	const allotmentDate = date("allotment_date", "Allotment date");
	if (closeDate < openDate) fail("Close date cannot be before the open date.");
	if (allotmentDate < closeDate) fail("Allotment date cannot be before the close date.");

	return {
		name,
		symbol,
		sector,
		min_price: minPrice,
		max_price: maxPrice,
		lot_size: lotSize,
		shares_offered: sharesOffered,
		listing_price: listingPrice,
		subscription_rate: subscriptionRate,
		open_date: openDate.toISOString(),
		close_date: closeDate.toISOString(),
		allotment_date: allotmentDate.toISOString(),
	};
};

/** A new IPO: its details plus the status it starts in. */
export const parseNewIpo = (body: unknown): NewIpo => {
	const fields = parseIpoFields(body);
	const status = (((body ?? {}) as Record<string, unknown>).status ??
		"dormant") as IpoStatus;
	if (!CREATABLE_STATUSES.includes(status)) {
		throw new TradingError(
			"INVALID_INPUT",
			"A new IPO starts as dormant, upcoming or open.",
		);
	}
	return { ...fields, status, is_open_to_subscription: status === "open" };
};

/** Refuses a symbol another IPO or a stock already has. */
const assertSymbolFree = async (symbol: string, exceptIpoId?: number) => {
	const except = exceptIpoId ?? null;
	const taken = await sql`
		SELECT 'ipo' AS kind FROM ipo
		WHERE symbol = ${symbol} AND (${except}::int IS NULL OR id <> ${except}::int)
		UNION ALL
		SELECT 'stock' FROM stocks WHERE symbol = ${symbol}
		LIMIT 1
	`;
	if (taken[0]) {
		throw new TradingError(
			"SYMBOL_TAKEN",
			taken[0].kind === "ipo"
				? `An IPO with symbol ${symbol} already exists.`
				: `A stock with symbol ${symbol} already exists.`,
		);
	}
};

/** Returns the new IPO's id. */
export const addIpo = async (ipoData: NewIpo) => {
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

	// Both are unique indexes; checked first for a sentence instead of a 500.
	await assertSymbolFree(symbol);

	const rows = await sql`
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
		RETURNING id
	`;
	return Number(rows[0].id);
};

// What an application is built on: it holds lots x lot_size x a bid inside
// the band, and allotment shares out shares_offered. Fixed once the IPO opens.
const TERMS = ["min_price", "max_price", "lot_size", "shares_offered"] as const;
const TERMS_EDITABLE_IN: IpoStatus[] = ["dormant", "upcoming"];

/**
 * Edits an IPO's details. The whole IPO is re-checked as create checks it, so
 * an edit can never leave it inconsistent. Status is not edited here: its
 * changes move money and go through updateIpoStatus.
 */
export const updateIpo = async (id: number, body: unknown) => {
	const input = (body ?? {}) as Record<string, unknown>;
	if (input.status !== undefined) {
		throw new TradingError(
			"INVALID_INPUT",
			"Change an IPO's status from the IPOs table, not by editing it.",
		);
	}

	const rows = await sql`
		SELECT name, symbol, sector, status,
			min_price::float8 AS min_price, max_price::float8 AS max_price,
			lot_size, shares_offered::float8 AS shares_offered,
			listing_price::float8 AS listing_price,
			subscription_rate::float8 AS subscription_rate,
			open_date, close_date, allotment_date
		FROM ipo WHERE id = ${id}
	`;
	const current = rows[0] as Record<string, unknown> | undefined;
	if (!current) throw new TradingError("IPO_NOT_FOUND", "IPO not found.");
	const status = current.status as IpoStatus;
	if (status === "listed" || status === "withdrawn") {
		throw new TradingError(
			"INVALID_INPUT",
			`A ${status} IPO can no longer be edited.`,
		);
	}

	// Dates come back as Date objects; the parser reads strings.
	const asInput = Object.fromEntries(
		Object.entries(current).map(([key, value]) => [
			key,
			value instanceof Date ? value.toISOString() : value,
		]),
	);
	const changes = Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	);
	const fields = parseIpoFields({ ...asInput, ...changes });

	if (
		!TERMS_EDITABLE_IN.includes(status) &&
		TERMS.some((key) => fields[key] !== Number(current[key]))
	) {
		throw new TradingError(
			"INVALID_INPUT",
			"The price band, lot size and shares offered can't change once the IPO has opened: players' applications are based on them.",
		);
	}
	if (fields.symbol !== current.symbol) await assertSymbolFree(fields.symbol, id);

	await sql`
		UPDATE ipo
		SET
			name = ${fields.name},
			symbol = ${fields.symbol},
			sector = ${fields.sector},
			min_price = ${fields.min_price},
			max_price = ${fields.max_price},
			lot_size = ${fields.lot_size},
			shares_offered = ${fields.shares_offered},
			listing_price = ${fields.listing_price},
			subscription_rate = ${fields.subscription_rate},
			open_date = ${fields.open_date},
			close_date = ${fields.close_date},
			allotment_date = ${fields.allotment_date},
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ${id}
	`;
	// Players see the new details without reloading.
	emitToMarket("iposChanged", { id });
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

	// Players can apply only while this is set, so it follows the status unless
	// the caller says otherwise: opening an IPO opens it for subscription.
	await sql`
		UPDATE ipo
		SET
			status = ${status},
			is_open_to_subscription = ${isOpenToSubscription ?? status === "open"},
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
