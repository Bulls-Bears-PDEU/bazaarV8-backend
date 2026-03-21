import sql from "../database/database.js";
import type { News } from "../models/news.js";

export const getAllNews = async () => {
	const result = await sql`
		SELECT
			id,
			title,
			content,
			is_released AS "isReleased",
			release_at,
			created_at,
			affected_sectors
		FROM news
		WHERE is_released = TRUE
		ORDER BY release_at DESC, created_at DESC
	`;
	return result as News[];
};

export const getAllNewsAdmin = async () => {
	const result = await sql`
		SELECT
			id,
			title,
			content,
			is_released AS "isReleased",
			release_at,
			created_at,
			affected_sectors
		FROM news
		ORDER BY release_at DESC, created_at DESC
	`;
	return result as News[];
};

export const getNewsById = async (id: number) => {
	const result = await sql`
		SELECT
			id,
			title,
			content,
			is_released AS "isReleased",
			release_at,
			created_at,
			affected_sectors
		FROM news
		WHERE id = ${id}
	`;
	return result[0] as News | undefined;
};

export const addNews = async (newsData: Omit<News, "id" | "created_at">) => {
	const { title, content, isReleased, release_at, affected_sectors } = newsData;
	console.log("Adding news with data:", newsData);
	await sql`
		INSERT INTO news (title, content, is_released, release_at, affected_sectors)
		VALUES (${title}, ${content}, ${isReleased ?? false}, ${release_at}, ${JSON.stringify(affected_sectors)})
	`;
};

export const updateNews = async (id: number, newsData: Partial<News>) => {
	const hasUpdates =
		newsData.title !== undefined ||
		newsData.content !== undefined ||
		newsData.isReleased !== undefined ||
		newsData.release_at !== undefined ||
		newsData.affected_sectors !== undefined;

	if (!hasUpdates) {
		return;
	}

	await sql`
		UPDATE news
		SET
			title = COALESCE(${newsData.title ?? null}, title),
			content = COALESCE(${newsData.content ?? null}, content),
			is_released = COALESCE(${newsData.isReleased ?? null}, is_released),
			release_at = COALESCE(${newsData.release_at ?? null}, release_at),
			affected_sectors = COALESCE(${JSON.stringify(newsData.affected_sectors ?? null)}::jsonb, affected_sectors)
		WHERE id = ${id}
	`;
};

export const updateNewsReleaseStatus = async (
	id: number,
	isReleased: boolean,
) => {
	await sql`
		UPDATE news
		SET is_released = ${isReleased}
		WHERE id = ${id}
	`;
};

export const deleteNews = async (id: number) => {
	await sql`DELETE FROM news WHERE id = ${id}`;
};
