export enum TransactionType {
	BUY = "buy",
	SELL = "sell",
	SHORT = "short",
	COVER = "cover",
}

export type User = {
	id: string;
	cash_balance: number;
	frozen_balance: number;
	createdAt: string;
};

export type UserStockTransaction = {
	id: number;
	user_id: string;
	stock_id: number;
	volume: number;
	price: number;
	transaction_type: TransactionType;
	timestamp: string;
};

export type UserPortfolio = {
	id: number;
	user_id: string;
	stock_id: number;
	volume: number;
	average_price: number;
};
