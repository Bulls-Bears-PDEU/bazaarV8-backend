export type OrderSide = "buy" | "sell";
/**
 * What the player asks for. buy opens or adds to a long, sell closes a long,
 * short opens or adds to a short, cover closes a short. The server refuses an
 * action that does not fit the position, so nothing ever flips by accident.
 */
export type OrderAction = "buy" | "sell" | "short" | "cover";
export const ORDER_ACTIONS: OrderAction[] = ["buy", "sell", "short", "cover"];
/** The side the matcher works with: buy and cover take shares, sell and short give them. */
export const sideOfAction = (action: OrderAction): OrderSide =>
	action === "buy" || action === "cover" ? "buy" : "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected";
// What a fill actually did, derived from the position: a buy covers a short
// before buying, a sell sells a long before shorting.
export type TransactionType = "buy" | "sell" | "short" | "cover";

export type Order = {
	id: number;
	user_id: string;
	stock_id: number;
	symbol: string;
	name: string;
	side: OrderSide;
	// Null for orders placed before actions existed.
	action: OrderAction | null;
	order_type: OrderType;
	quantity: number;
	filled_quantity: number;
	limit_price: number | null;
	average_fill_price: number | null;
	reserved_cash: number;
	reserved_margin: number;
	// reserved_cash + reserved_margin, for display.
	reserved_total: number;
	status: OrderStatus;
	reject_reason: string | null;
	created_at: string;
	updated_at: string;
	filled_at: string | null;
	cancelled_at: string | null;
};

export type Fill = {
	transaction_type: TransactionType;
	quantity: number;
	price: number;
	realized_pnl: number;
	margin_locked?: number;
};

/** What bazaar_execute_fill returns. */
export type FillResult = {
	status: "filled";
	order_id: number;
	user_id: string;
	stock_id: number;
	side: OrderSide;
	action: OrderAction | null;
	order_type: OrderType;
	quantity: number;
	price: number;
	fills: Fill[];
	realized_pnl: number;
	position: {
		stock_id: number;
		volume: number;
		average_price: number;
		margin_locked: number;
	};
	cash_balance: number;
	frozen_balance: number;
};

export type PlaceOrderInput = {
	stock_id: number;
	side: OrderSide;
	// Null only for callers that still send a bare side.
	action: OrderAction | null;
	order_type: OrderType;
	quantity: number;
	limit_price?: number;
};

export type TradeLedgerEntry = {
	id: number;
	order_id: number | null;
	stock_id: number;
	symbol: string;
	name: string;
	transaction_type: TransactionType;
	volume: number;
	price: number;
	value: number;
	realized_pnl: number;
	timestamp: string;
};
