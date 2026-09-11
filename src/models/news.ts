export type News = {
		id: number;
		title: string;
		content: string; // This will be in MD format
		isReleased: boolean;
		release_at: string;
		created_at: string;
		// Stock id or symbol -> fractional price impact, applied over 60s on release.
		affected_stocks: Record<string, number>;
	};
