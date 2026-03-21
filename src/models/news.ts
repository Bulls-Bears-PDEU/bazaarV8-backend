export type News = {
	id: number;
	title: string;
	content: string; // This will be in MD format
	isReleased: boolean;
	release_at: string;
	created_at: string;
	affected_sectors: Record<string, number>; // sector name to impact percentage mapping
};
