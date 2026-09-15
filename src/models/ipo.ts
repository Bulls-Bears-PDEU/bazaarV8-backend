export type IpoStatus =
	| "dormant"
	| "upcoming"
	| "open"
	| "closed"
	| "listed"
	| "withdrawn";

export type Ipo = {
	id: number;
	name: string;
	symbol: string;
	close_date: string;
	open_date: string;
	allotment_date: string;
	subscription_rate: number;
	sector: string;
	is_open_to_subscription: boolean;
	lot_size: number;
	max_price: number;
	min_price: number;
	status: IpoStatus;
	shares_offered: number;
	// Whole lots on offer, and one lot at the top of the band.
	lots_offered?: number;
	lot_value_at_max?: number;
	listing_price: number;
	// Set when allotment runs; the price every allottee pays.
	allotment_price: number | null;
	allotment_completed_at: string | null;
	// The stock created when the IPO lists.
	listed_stock_id: number | null;
	created_at: string;
	updated_at?: string;
};
