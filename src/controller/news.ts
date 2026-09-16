import sql from "../database/database.js";
import eventEmitter from "../eventEmitter.js";
import {
	type AdminNews,
	NEWS_LIMITS,
	type News,
	type NewsImpact,
	type NewsImpactDetail,
} from "../models/news.js";
import { emitToAdmins, emitToMarket } from "../realtime/emitter.js";

/** A request the news routes answer with `status` and the message as-is. */
export class NewsError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/**
 * What the stock engine is told when a story's impact should start. Durations
 * are resolved (no nulls), and elapsedSeconds is how much of the move already
 * happened, non-zero only when picking up after a restart.
 */
export type NewsImpactRelease = {
	id: number;
	impacts: { stock_id: number; impact_pct: number; duration_seconds: number }[];
	elapsedSeconds: number;
};

type StockRef = { id: number; symbol: string; name: string; sector: string };

const loadStockRefs = async (): Promise<StockRef[]> => {
	const rows = await sql`SELECT id, symbol, name, sector FROM stocks ORDER BY symbol`;
	return rows.map((row) => ({
		id: Number(row.id),
		symbol: String(row.symbol),
		name: String(row.name),
		sector: String(row.sector),
	}));
};

// ---------------------------------------------------------------------------
// Impacts: stored form <-> API form
// ---------------------------------------------------------------------------

/**
 * Reads affected_stocks. Current rows hold {"<stock id>": {impact_pct,
 * duration_seconds}}; older ones hold {"SYMBOL" or "<id>": pct}. Entries for
 * stocks that no longer exist are dropped.
 */
const parseStoredImpacts = (
	affected: unknown,
	stocks: StockRef[],
): NewsImpactDetail[] => {
	if (!affected || typeof affected !== "object" || Array.isArray(affected)) {
		return [];
	}
	const byId = new Map(stocks.map((stock) => [stock.id, stock]));
	const bySymbol = new Map(
		stocks.map((stock) => [stock.symbol.toUpperCase(), stock]),
	);

	const impacts: NewsImpactDetail[] = [];
	for (const [key, value] of Object.entries(affected)) {
		const identifier = key.trim();
		const stock = /^\d+$/.test(identifier)
			? byId.get(Number(identifier))
			: bySymbol.get(identifier.toUpperCase());
		if (!stock) continue;

		const entry: Record<string, unknown> =
			value !== null && typeof value === "object"
				? (value as Record<string, unknown>)
				: { impact_pct: value };
		const impactPct = Number(entry.impact_pct);
		if (!Number.isFinite(impactPct) || impactPct === 0) continue;
		const duration =
			entry.duration_seconds === null || entry.duration_seconds === undefined
				? null
				: Number(entry.duration_seconds);

		impacts.push({
			stock_id: stock.id,
			symbol: stock.symbol,
			name: stock.name,
			sector: stock.sector,
			impact_pct: impactPct,
			duration_seconds:
				duration !== null && Number.isFinite(duration) ? duration : null,
		});
	}
	return impacts.sort((a, b) => a.symbol.localeCompare(b.symbol));
};

const serializeImpacts = (impacts: NewsImpact[]) =>
	JSON.stringify(
		Object.fromEntries(
			impacts.map((impact) => [
				String(impact.stock_id),
				{
					impact_pct: impact.impact_pct,
					duration_seconds: impact.duration_seconds,
				},
			]),
		),
	);

const validateDuration = (value: unknown, label: string) => {
	const seconds = Number(value);
	if (
		!Number.isInteger(seconds) ||
		seconds < NEWS_LIMITS.minDurationSeconds ||
		seconds > NEWS_LIMITS.maxDurationSeconds
	) {
		throw new NewsError(
			400,
			`${label} must be a whole number of seconds from ${NEWS_LIMITS.minDurationSeconds} to ${NEWS_LIMITS.maxDurationSeconds}.`,
		);
	}
	return seconds;
};

const validateImpacts = (
	value: unknown,
	stocks: StockRef[],
): NewsImpact[] => {
	if (!Array.isArray(value)) {
		throw new NewsError(400, "impacts must be a list.");
	}
	const byId = new Map(stocks.map((stock) => [stock.id, stock]));
	const seen = new Set<number>();

	return value.map((raw) => {
		const entry = (raw ?? {}) as Record<string, unknown>;
		const stock = byId.get(Number(entry.stock_id));
		if (!stock) {
			throw new NewsError(400, `No stock with id ${String(entry.stock_id)}.`);
		}
		if (seen.has(stock.id)) {
			throw new NewsError(400, `${stock.symbol} is listed more than once.`);
		}
		seen.add(stock.id);

		const impactPct = Number(entry.impact_pct);
		if (
			!Number.isFinite(impactPct) ||
			impactPct === 0 ||
			Math.abs(impactPct) > NEWS_LIMITS.maxImpactPct
		) {
			throw new NewsError(
				400,
				`${stock.symbol}: impact must be a non-zero percentage between -${NEWS_LIMITS.maxImpactPct} and ${NEWS_LIMITS.maxImpactPct}.`,
			);
		}
		const duration =
			entry.duration_seconds === null || entry.duration_seconds === undefined
				? null
				: validateDuration(entry.duration_seconds, `${stock.symbol}: duration`);

		return {
			stock_id: stock.id,
			impact_pct: Math.round(impactPct * 100) / 100,
			duration_seconds: duration,
		};
	});
};

const validateReleaseAt = (value: unknown) => {
	const date = new Date(String(value));
	if (value === undefined || value === null || Number.isNaN(date.getTime())) {
		throw new NewsError(400, "release_at must be a valid date.");
	}
	return date.toISOString();
};

const requiredText = (value: unknown, label: string) => {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new NewsError(400, `${label} is required.`);
	return text;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const toPlayerNews = (row: Record<string, unknown>): News => ({
	id: Number(row.id),
	title: String(row.title),
	content: String(row.content),
	release_at: row.release_at as string,
});

export const getAllNews = async (): Promise<News[]> => {
	const rows = await sql`
		SELECT id, title, content, release_at
		FROM news
		WHERE is_released = TRUE
		ORDER BY release_at DESC, created_at DESC
	`;
	return rows.map(toPlayerNews);
};

/**
 * Unreleased news moves prices when it drops, so only admins may read it before
 * release. Without the filter any player could fetch it by guessing an id.
 */
export const getNewsById = async (
	id: number,
	includeUnreleased = false,
): Promise<News | undefined> => {
	const rows = await sql`
		SELECT id, title, content, release_at
		FROM news
		WHERE id = ${id}
			AND (${includeUnreleased} OR is_released = TRUE)
	`;
	return rows[0] ? toPlayerNews(rows[0]) : undefined;
};

const selectAdminNews = (id: number | null) => sql`
	SELECT
		id,
		title,
		content,
		is_released,
		release_at,
		created_at,
		first_released_at,
		impact_duration_seconds,
		affected_stocks
	FROM news
	WHERE ${id}::int IS NULL OR id = ${id}
	ORDER BY release_at DESC, created_at DESC
`;

const toAdminNews = (
	row: Record<string, unknown>,
	stocks: StockRef[],
): AdminNews => ({
	...toPlayerNews(row),
	isReleased: Boolean(row.is_released),
	created_at: row.created_at as string,
	first_released_at: (row.first_released_at as string | null) ?? null,
	default_duration_seconds: Number(row.impact_duration_seconds),
	impacts: parseStoredImpacts(row.affected_stocks, stocks),
});

export const getAllNewsAdmin = async (): Promise<AdminNews[]> => {
	const [rows, stocks] = await Promise.all([
		selectAdminNews(null),
		loadStockRefs(),
	]);
	return rows.map((row) => toAdminNews(row, stocks));
};

const getAdminNewsById = async (id: number) => {
	const [rows, stocks] = await Promise.all([
		selectAdminNews(id),
		loadStockRefs(),
	]);
	return rows[0] ? toAdminNews(rows[0], stocks) : undefined;
};

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

/**
 * Puts a story out. The first time, it takes release_at (if it was scheduled
 * later), stamps first_released_at and starts its price impact; releasing a
 * story that was hidden again only shows it. Returns false when the story is
 * already out or does not exist.
 *
 * One statement, and the row lock makes a second concurrent release (the
 * scheduler and an admin at once) find the story already out, so an impact can
 * never be applied twice.
 */
export const releaseNews = async (id: number) => {
	const now = new Date().toISOString();
	const rows = await sql`
		WITH target AS (
			SELECT id, first_released_at IS NULL AS first_release
			FROM news
			WHERE id = ${id} AND is_released = FALSE
			FOR UPDATE
		)
		UPDATE news n
		SET
			is_released = TRUE,
			release_at = CASE
				WHEN target.first_release THEN LEAST(n.release_at, ${now}::timestamp)
				ELSE n.release_at
			END,
			first_released_at = COALESCE(n.first_released_at, ${now}::timestamp)
		FROM target
		WHERE n.id = target.id
		RETURNING n.id, target.first_release, n.affected_stocks, n.impact_duration_seconds
	`;
	const row = rows[0];
	if (!row) return false;

	if (row.first_release) {
		const stocks = await loadStockRefs();
		const release: NewsImpactRelease = {
			id,
			impacts: parseStoredImpacts(row.affected_stocks, stocks).map((impact) => ({
				stock_id: impact.stock_id,
				impact_pct: impact.impact_pct,
				duration_seconds:
					impact.duration_seconds ?? Number(row.impact_duration_seconds),
			})),
			elapsedSeconds: 0,
		};
		eventEmitter.emit("newsImpactReleased", release);
	}
	// Players refetch the feed and see the headline straight away.
	emitToMarket("newsReleased", { id });
	emitToAdmins("newsChanged", { id });
	return true;
};

/** Takes a story off the feed. Its price impact, if any, is not undone. */
export const hideNews = async (id: number) => {
	const rows = await sql`
		UPDATE news SET is_released = FALSE WHERE id = ${id} RETURNING id
	`;
	if (rows.length === 0) throw new NewsError(404, "News not found.");
	emitToMarket("newsChanged", { id });
	emitToAdmins("newsChanged", { id });
};

/** Releases every scheduled story whose time has come. Run on a timer. */
export const releaseDueNews = async () => {
	const rows = await sql`
		SELECT id
		FROM news
		WHERE is_released = FALSE
			AND first_released_at IS NULL
			AND release_at <= ${new Date().toISOString()}::timestamp
		ORDER BY release_at
	`;
	for (const row of rows) {
		if (await releaseNews(Number(row.id))) {
			console.log(`News ${row.id}: released on schedule`);
		}
	}
};

/**
 * The engine keeps impacts in memory, so a restart part way through a story
 * would drop the rest of its move. Hands it back whatever is still to come,
 * judged by the wall clock since release (time the market spent paused counts
 * as elapsed). Prices were saved every tick, so what already landed is kept.
 */
export const resumeNewsImpacts = async () => {
	const now = Date.now();
	const since = new Date(
		now - NEWS_LIMITS.maxDurationSeconds * 1000,
	).toISOString();
	const rows = await sql`
		SELECT id, affected_stocks, impact_duration_seconds, first_released_at
		FROM news
		WHERE first_released_at >= ${since}::timestamp
	`;
	if (rows.length === 0) return;

	const stocks = await loadStockRefs();
	for (const row of rows) {
		const elapsedSeconds =
			(now - new Date(row.first_released_at as string).getTime()) / 1000;
		const impacts = parseStoredImpacts(row.affected_stocks, stocks)
			.map((impact) => ({
				stock_id: impact.stock_id,
				impact_pct: impact.impact_pct,
				duration_seconds:
					impact.duration_seconds ?? Number(row.impact_duration_seconds),
			}))
			.filter((impact) => impact.duration_seconds > elapsedSeconds);
		if (impacts.length === 0) continue;

		const release: NewsImpactRelease = {
			id: Number(row.id),
			impacts,
			elapsedSeconds,
		};
		eventEmitter.emit("newsImpactReleased", release);
		console.log(
			`News ${row.id}: resuming ${impacts.length} impact(s) ${Math.round(elapsedSeconds)}s in`,
		);
	}
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const addNews = async (input: unknown) => {
	const body = (input ?? {}) as Record<string, unknown>;
	const title = requiredText(body.title, "Title");
	const content = requiredText(body.content, "Content");
	const releaseNow = body.release_now === true;
	const releaseAt = releaseNow
		? new Date().toISOString()
		: validateReleaseAt(body.release_at);
	const defaultDuration =
		body.default_duration_seconds === undefined
			? NEWS_LIMITS.defaultDurationSeconds
			: validateDuration(body.default_duration_seconds, "Default duration");
	const impacts =
		body.impacts === undefined
			? []
			: validateImpacts(body.impacts, await loadStockRefs());

	const rows = await sql`
		INSERT INTO news (title, content, is_released, release_at, impact_duration_seconds, affected_stocks)
		VALUES (${title}, ${content}, FALSE, ${releaseAt}::timestamp, ${defaultDuration}, ${serializeImpacts(impacts)}::jsonb)
		RETURNING id
	`;
	const id = Number(rows[0].id);

	if (new Date(releaseAt).getTime() <= Date.now()) {
		await releaseNews(id);
	} else {
		emitToAdmins("newsChanged", { id });
	}
	return getAdminNewsById(id);
};

/**
 * Edits a story. Its impacts and default duration are locked once it has been
 * released, since they have already moved prices.
 */
export const updateNews = async (id: number, input: unknown) => {
	const body = (input ?? {}) as Record<string, unknown>;
	const existing = await sql`
		SELECT first_released_at FROM news WHERE id = ${id}
	`;
	if (existing.length === 0) throw new NewsError(404, "News not found.");
	const alreadyReleased = existing[0].first_released_at !== null;

	const changesImpact =
		body.impacts !== undefined || body.default_duration_seconds !== undefined;
	if (alreadyReleased && changesImpact) {
		throw new NewsError(
			409,
			"This story has already moved prices, so its impacts can no longer be changed.",
		);
	}
	if (alreadyReleased && body.release_at !== undefined) {
		throw new NewsError(409, "This story has already been released.");
	}

	const title =
		body.title === undefined ? null : requiredText(body.title, "Title");
	const content =
		body.content === undefined ? null : requiredText(body.content, "Content");
	const releaseAt =
		body.release_now === true
			? new Date().toISOString()
			: body.release_at === undefined
				? null
				: validateReleaseAt(body.release_at);
	const defaultDuration =
		body.default_duration_seconds === undefined
			? null
			: validateDuration(body.default_duration_seconds, "Default duration");
	const impacts =
		body.impacts === undefined
			? null
			: serializeImpacts(validateImpacts(body.impacts, await loadStockRefs()));

	await sql`
		UPDATE news
		SET
			title = COALESCE(${title}, title),
			content = COALESCE(${content}, content),
			release_at = COALESCE(${releaseAt}::timestamp, release_at),
			impact_duration_seconds = COALESCE(${defaultDuration}::int, impact_duration_seconds),
			affected_stocks = COALESCE(${impacts}::jsonb, affected_stocks)
		WHERE id = ${id}
	`;

	if (!alreadyReleased && releaseAt && new Date(releaseAt).getTime() <= Date.now()) {
		await releaseNews(id);
	} else {
		// A released story's new wording reaches players too.
		if (alreadyReleased) emitToMarket("newsChanged", { id });
		emitToAdmins("newsChanged", { id });
	}
	return getAdminNewsById(id);
};

export const deleteNews = async (id: number) => {
	const rows = await sql`DELETE FROM news WHERE id = ${id} RETURNING id`;
	if (rows.length === 0) throw new NewsError(404, "News not found.");
	emitToMarket("newsChanged", { id });
	emitToAdmins("newsChanged", { id });
};
