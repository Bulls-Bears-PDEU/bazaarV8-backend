/** Bounds the API enforces on a story's price impact. */
export const NEWS_LIMITS = {
	maxImpactPct: 50,
	minDurationSeconds: 1,
	maxDurationSeconds: 2 * 60 * 60,
	defaultDurationSeconds: 60,
} as const;

/**
 * How one stock reacts to a story: a percentage move priced in over
 * duration_seconds, or over the story's default duration when that is null.
 */
export type NewsImpact = {
	stock_id: number;
	impact_pct: number;
	duration_seconds: number | null;
};

/** An impact with the stock it points at, for the admin panel. */
export type NewsImpactDetail = NewsImpact & {
	symbol: string;
	name: string;
	sector: string;
};

/**
 * What players get. Impacts are left out on purpose: knowing a story is worth
 * +4% over ten minutes would let a player trade the rest of the move.
 */
export type News = {
	id: number;
	title: string;
	content: string; // Markdown
	release_at: string;
};

export type AdminNews = News & {
	isReleased: boolean;
	created_at: string;
	// When the story first went out and moved prices; null until it has.
	first_released_at: string | null;
	default_duration_seconds: number;
	impacts: NewsImpactDetail[];
};

/** Body of addNews and updateNews. Every field is optional on update. */
export type NewsInput = {
	title: string;
	content: string;
	release_at: string;
	// Release as soon as it is saved, whatever release_at says.
	release_now?: boolean;
	default_duration_seconds?: number;
	impacts?: NewsImpact[];
};
