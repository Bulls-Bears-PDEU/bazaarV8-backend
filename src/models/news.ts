export type News = {
		id: number;
		title: string;
		content: string; // This will be in MD format
		isReleased: boolean;
		release_at: string;
		created_at: string;
		affected_stocks: Record<string, number>; // stock id to impact percentage mapping
	};
