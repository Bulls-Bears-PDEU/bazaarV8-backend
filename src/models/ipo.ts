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
	listing_price: number;
	created_at: string;
	updated_at?: string;
};
