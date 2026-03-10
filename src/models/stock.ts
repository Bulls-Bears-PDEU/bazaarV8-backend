type Stock = {
	id: number;
	name: string;
	symbol: string;
	price: number;
	ohlc: {
		open: number;
		high: number;
		low: number;
		close: number;
	}[];
	sector: string;
	volume: number;
	drift: number;
	volatility: number;
	created_at: string;
	isLocked: boolean;
};

export default Stock;
