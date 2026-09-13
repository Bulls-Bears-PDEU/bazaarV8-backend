export type OrderSide = "buy" | "sell";
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
	order_type: OrderType;
	quantity: number;
	filled_quantity: number;
	limit_price: number | null;
	average_fill_price: number | null;
	reserved_cash: number;
	reserved_margin: number;
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
