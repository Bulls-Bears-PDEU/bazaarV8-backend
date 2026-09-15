import type { Response } from "express";

/**
 * Every trading route answers errors as { error, code }. The code is stable and
 * meant for the client to branch on; error is a sentence to show the player.
 */
export type TradingErrorCode =
	| "INSUFFICIENT_FUNDS"
	| "INSUFFICIENT_MARGIN"
	| "STOCK_LOCKED"
	| "STOCK_NOT_FOUND"
	| "MARKET_PAUSED"
	| "SHORTING_DISABLED"
	// The action does not fit the position: buying while short, shorting while long.
	| "POSITION_CONFLICT"
	// Selling or covering with nothing of that kind to close.
	| "NO_POSITION"
	| "LIMIT_ORDERS_DISABLED"
	| "INVALID_ORDER"
	| "INVALID_QUANTITY"
	| "NO_PRICE"
	| "ORDER_NOT_FOUND"
	| "ORDER_NOT_PENDING"
	| "WATCHLIST_NOT_FOUND"
	| "ALERT_NOT_FOUND"
	| "DUPLICATE_NAME"
	| "LIMIT_REACHED"
	| "INVALID_INPUT"
	| "IPO_NOT_FOUND"
	| "IPO_NOT_OPEN"
	| "IPO_NOT_CLOSED"
	| "IPO_ALREADY_LISTED"
	| "ALREADY_APPLIED"
	| "APPLICATION_NOT_FOUND"
	| "ALLOTMENT_DONE"
	| "ALLOTMENT_PENDING"
	| "SYMBOL_TAKEN"
	| "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<TradingErrorCode, number> = {
	INSUFFICIENT_FUNDS: 400,
	INSUFFICIENT_MARGIN: 400,
	STOCK_LOCKED: 403,
	STOCK_NOT_FOUND: 404,
	MARKET_PAUSED: 403,
	SHORTING_DISABLED: 403,
	POSITION_CONFLICT: 409,
	NO_POSITION: 409,
	LIMIT_ORDERS_DISABLED: 403,
	INVALID_ORDER: 400,
	INVALID_QUANTITY: 400,
	NO_PRICE: 409,
	ORDER_NOT_FOUND: 404,
	// Lost a race with a fill or cancel; the client should refetch the order.
	ORDER_NOT_PENDING: 409,
	WATCHLIST_NOT_FOUND: 404,
	ALERT_NOT_FOUND: 404,
	DUPLICATE_NAME: 409,
	LIMIT_REACHED: 400,
	INVALID_INPUT: 400,
	IPO_NOT_FOUND: 404,
	IPO_NOT_OPEN: 403,
	IPO_NOT_CLOSED: 409,
	IPO_ALREADY_LISTED: 409,
	ALREADY_APPLIED: 409,
	APPLICATION_NOT_FOUND: 404,
	ALLOTMENT_DONE: 409,
	ALLOTMENT_PENDING: 409,
	SYMBOL_TAKEN: 409,
	INTERNAL_ERROR: 500,
};

/** Postgres error code of a failed query, e.g. "23505" for a unique violation. */
export const pgErrorCode = (error: unknown): string | undefined =>
	(error as { code?: string })?.code;

export class TradingError extends Error {
	constructor(
		public readonly code: TradingErrorCode,
		message: string,
	) {
		super(message);
	}
}

/**
 * The settlement functions raise the code as the message and a readable DETAIL
 * (see createSettlementFunctions in database/schema.ts).
 */
export const toTradingError = (error: unknown): TradingError => {
	if (error instanceof TradingError) {
		return error;
	}
	const candidate = error as { message?: string; detail?: string };
	if (candidate?.message && candidate.message in STATUS_BY_CODE) {
		return new TradingError(
			candidate.message as TradingErrorCode,
			candidate.detail ?? candidate.message,
		);
	}
	console.error("Unexpected trading error:", error);
	return new TradingError("INTERNAL_ERROR", "Something went wrong.");
};

export const sendTradingError = (res: Response, error: unknown) => {
	const tradingError = toTradingError(error);
	res
		.status(STATUS_BY_CODE[tradingError.code])
		.json({ error: tradingError.message, code: tradingError.code });
};
