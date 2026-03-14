export type Stock = {
	id: number;
	name: string;
	symbol: string;
	sector: string;
	volatility: number;
	created_at: string;
	isLocked: boolean;
};

export type StockOHLC = {
	id: number;
	stock_id: number;
	open_price: number;
	high_price: number;
	low_price: number;
	close_price: number;
	timestamp: string;
};
