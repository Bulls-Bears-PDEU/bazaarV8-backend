export type Stock = {
	id: number;
	name: string;
	symbol: string;
	sector: string;
	volatility: number;
	created_at: string;
	// Trading halted for this stock. Matches the SQL column name; the API has
	// always returned `locked`, never `isLocked`.
	locked: boolean;
	// Latest simulated price, written every tick. Null only before the first.
	last_price: number | null;
	last_price_at: string | null;
	name_tsv: string;
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

export type StockPrice = {
	price: number;
	indicator?: "up" | "down" | "neutral";
	priceChange?: number;
};
