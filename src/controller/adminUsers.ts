import sql from "../database/database.js";
import { emitToAdmins, emitToUser, onlineUserIds } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";
import { broadcastLeaderboard, getRankForUser } from "./leaderboard.js";
import { getOrderHistory } from "./orders.js";
import { getPortfolio, STARTING_CAPITAL } from "./portfolio.js";
import { normalizeName } from "./profile.js";

/**
 * The admin panel's view of every account: searchable, filterable and sorted
 * on the server so it stays quick with any number of players, with net worth
 * worked out here (marked to the last price) rather than in the browser.
 */

export type UserStatus = "pending" | "active" | "banned";
export type StatusFilter = UserStatus | "online" | "all";
export type SortKey = "joined" | "name" | "cash" | "net_worth";

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export type AdminUserRow = {
	id: string;
	name: string;
	email: string;
	image: string | null;
	role: string;
	status: UserStatus;
	ban_reason: string | null;
	ban_expires: string | null;
	created_at: string;
	onboarded_at: string | null;
	email_verified: boolean;
	cash_balance: number;
	net_worth: number;
	pnl: number;
	online: boolean;
	hidden_from_leaderboard: boolean;
};

export type ListUsersQuery = {
	search: string;
	status: StatusFilter;
	role: "all" | "user" | "admin" | "pending";
	sort: SortKey;
	direction: "asc" | "desc";
	page: number;
	pageSize: number;
};

const STATUSES: StatusFilter[] = ["all", "pending", "active", "banned", "online"];
const ROLES = ["all", "user", "admin", "pending"] as const;
const SORTS: SortKey[] = ["joined", "name", "cash", "net_worth"];

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

export const parseListUsersQuery = (query: Record<string, unknown>): ListUsersQuery => {
	const page = Number(query.page);
	const pageSize = Number(query.page_size);
	return {
		search: typeof query.search === "string" ? query.search.trim().slice(0, 100) : "",
		status: pick(query.status, STATUSES, "all"),
		role: pick(query.role, ROLES, "all"),
		sort: pick(query.sort, SORTS, "joined"),
		direction: query.direction === "asc" ? "asc" : "desc",
		page: Number.isInteger(page) && page > 0 ? page : 1,
		pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25,
	};
};

// A ban counts while it has no expiry or has not expired yet.
const statusOf = (row: Record<string, unknown>): UserStatus => {
	const banned =
		Boolean(row.banned) && (!row.ban_expires || new Date(row.ban_expires as string).getTime() > Date.now());
	if (banned) return "banned";
	return row.role === "pending" ? "pending" : "active";
};

const toRow = (row: Record<string, unknown>, online: Set<string>): AdminUserRow => {
	const netWorth = Number(row.net_worth);
	return {
		id: String(row.id),
		name: String(row.name ?? ""),
		email: String(row.email ?? ""),
		image: (row.image as string | null) ?? null,
		role: String(row.role ?? "pending"),
		status: statusOf(row),
		ban_reason: (row.ban_reason as string | null) ?? null,
		ban_expires: row.ban_expires ? new Date(row.ban_expires as string).toISOString() : null,
		created_at: new Date(row.created_at as string).toISOString(),
		onboarded_at: row.onboarded_at ? new Date(row.onboarded_at as string).toISOString() : null,
		email_verified: Boolean(row.email_verified),
		cash_balance: Number(row.cash_balance),
		net_worth: netWorth,
		pnl: Math.round((netWorth - STARTING_CAPITAL) * 100) / 100,
		online: online.has(String(row.id)),
		hidden_from_leaderboard: Boolean(row.hidden_from_leaderboard),
	};
};

/** Escapes LIKE wildcards so a search for "50%" means exactly that. */
const likePattern = (search: string) => `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export const listUsers = async (query: ListUsersQuery) => {
	const online = onlineUserIds();
	const pattern = query.search ? likePattern(query.search) : null;
	const offset = (query.page - 1) * query.pageSize;
	const asc = query.direction === "asc";

	const rows = await sql`
		WITH base AS (
			SELECT
				u.id, u.name, u.email, u.image, u.role, u.banned,
				u."banReason" AS ban_reason, u."banExpires" AS ban_expires,
				u."createdAt" AS created_at, u.onboarded_at, u."emailVerified" AS email_verified,
				u.hidden_from_leaderboard,
				u.cash_balance::float8 AS cash_balance,
				(u.cash_balance + u.frozen_balance + COALESCE(holdings.value, 0))::float8 AS net_worth,
				(COALESCE(u.banned, FALSE) AND (u."banExpires" IS NULL OR u."banExpires" > NOW())) AS is_banned
			FROM users u
			LEFT JOIN LATERAL (
				SELECT SUM(
					CASE
						WHEN p.volume > 0 THEN p.volume * COALESCE(s.last_price, p.average_price)
						ELSE (p.average_price - COALESCE(s.last_price, p.average_price)) * (-p.volume)
					END
				) AS value
				FROM user_portfolios p
				JOIN stocks s ON s.id = p.stock_id
				WHERE p.user_id = u.id AND p.volume <> 0
			) holdings ON TRUE
			WHERE (${pattern}::text IS NULL OR u.name ILIKE ${pattern} OR u.email ILIKE ${pattern})
				AND (${query.role}::text = 'all' OR u.role = ${query.role}::text)
		)
		SELECT *, COUNT(*) OVER ()::int AS total
		FROM base
		WHERE CASE ${query.status}::text
			WHEN 'pending' THEN role = 'pending' AND NOT is_banned
			WHEN 'active' THEN role <> 'pending' AND NOT is_banned
			WHEN 'banned' THEN is_banned
			WHEN 'online' THEN id = ANY(${online}::text[])
			ELSE TRUE
		END
		ORDER BY
			CASE WHEN ${query.sort}::text = 'name' AND ${asc}::boolean THEN lower(name) END ASC,
			CASE WHEN ${query.sort}::text = 'name' AND NOT ${asc}::boolean THEN lower(name) END DESC,
			CASE WHEN ${query.sort}::text = 'cash' AND ${asc}::boolean THEN cash_balance END ASC,
			CASE WHEN ${query.sort}::text = 'cash' AND NOT ${asc}::boolean THEN cash_balance END DESC,
			CASE WHEN ${query.sort}::text = 'net_worth' AND ${asc}::boolean THEN net_worth END ASC,
			CASE WHEN ${query.sort}::text = 'net_worth' AND NOT ${asc}::boolean THEN net_worth END DESC,
			CASE WHEN ${query.sort}::text = 'joined' AND ${asc}::boolean THEN created_at END ASC,
			created_at DESC,
			id
		LIMIT ${query.pageSize}::int OFFSET ${offset}::int
	`;

	const onlineSet = new Set(online);
	return {
		users: rows.map((row) => toRow(row, onlineSet)),
		total: rows.length > 0 ? Number(rows[0].total) : await countMatching(query, pattern, online),
		page: query.page,
		page_size: query.pageSize,
	};
};

// A page past the end has no rows to read the total from.
const countMatching = async (query: ListUsersQuery, pattern: string | null, online: string[]) => {
	if (query.page === 1) return 0;
	const rows = await sql`
		SELECT COUNT(*)::int AS total FROM users u
		WHERE (${pattern}::text IS NULL OR u.name ILIKE ${pattern} OR u.email ILIKE ${pattern})
			AND (${query.role}::text = 'all' OR u.role = ${query.role}::text)
			AND CASE ${query.status}::text
				WHEN 'pending' THEN u.role = 'pending' AND NOT (COALESCE(u.banned, FALSE) AND (u."banExpires" IS NULL OR u."banExpires" > NOW()))
				WHEN 'active' THEN u.role <> 'pending' AND NOT (COALESCE(u.banned, FALSE) AND (u."banExpires" IS NULL OR u."banExpires" > NOW()))
				WHEN 'banned' THEN COALESCE(u.banned, FALSE) AND (u."banExpires" IS NULL OR u."banExpires" > NOW())
				WHEN 'online' THEN u.id = ANY(${online}::text[])
				ELSE TRUE
			END
	`;
	return Number(rows[0].total);
};

export const getUserStats = async () => {
	const online = onlineUserIds();
	const rows = await sql`
		SELECT
			COUNT(*)::int AS total,
			COUNT(*) FILTER (WHERE role = 'pending' AND NOT is_banned)::int AS pending,
			COUNT(*) FILTER (WHERE role <> 'pending' AND NOT is_banned)::int AS active,
			COUNT(*) FILTER (WHERE is_banned)::int AS banned,
			COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
			COUNT(*) FILTER (WHERE id = ANY(${online}::text[]))::int AS online,
			COUNT(*) FILTER (WHERE role = 'user' AND onboarded_at IS NULL AND NOT is_banned)::int AS not_onboarded
		FROM (
			SELECT id, role, onboarded_at,
				(COALESCE(banned, FALSE) AND ("banExpires" IS NULL OR "banExpires" > NOW())) AS is_banned
			FROM users
		) u
	`;
	return rows[0] as {
		total: number;
		pending: number;
		active: number;
		banned: number;
		admins: number;
		online: number;
		not_onboarded: number;
	};
};

export const getUserDetail = async (userId: string) => {
	const rows = await sql`
		SELECT
			u.id, u.name, u.email, u.image, u.role, u.banned,
			u."banReason" AS ban_reason, u."banExpires" AS ban_expires,
			u."createdAt" AS created_at, u.onboarded_at, u."emailVerified" AS email_verified,
			u.hidden_from_leaderboard,
			u.cash_balance::float8 AS cash_balance, 0::float8 AS net_worth,
			(SELECT MAX(s."updatedAt") FROM session s WHERE s."userId" = u.id) AS last_session_at
		FROM users u
		WHERE u.id = ${userId}
	`;
	if (!rows[0]) {
		throw new TradingError("INVALID_INPUT", "No such user.");
	}

	const [portfolio, orders, rank] = await Promise.all([
		getPortfolio(userId),
		getOrderHistory(userId, { limit: 10, offset: 0 }),
		getRankForUser(userId),
	]);
	const online = new Set(onlineUserIds());
	const base = toRow({ ...rows[0], net_worth: portfolio.totals.net_worth }, online);

	return {
		user: {
			...base,
			last_session_at: rows[0].last_session_at ? new Date(rows[0].last_session_at as string).toISOString() : null,
		},
		money: {
			cash_balance: portfolio.cash_balance,
			frozen_balance: portfolio.frozen_balance,
			net_worth: portfolio.totals.net_worth,
			total_pnl: portfolio.totals.total_pnl,
			return_pct: portfolio.totals.return_pct,
			unrealized_pnl: portfolio.totals.unrealized_pnl,
			realized_pnl: portfolio.totals.realized_pnl,
		},
		rank: rank ? { rank: rank.rank, total_players: rank.total_players } : null,
		positions: portfolio.positions,
		recent_orders: orders.orders,
		order_count: orders.total,
	};
};

/**
 * Name, photo removal, cash and leaderboard visibility, straight in the database. Role changes and
 * bans go through Better Auth (see the routes) so sessions are revoked too.
 */
export const updateUserAsAdmin = async (userId: string, body: unknown) => {
	const input = (body ?? {}) as Record<string, unknown>;
	const name = input.name === undefined ? null : normalizeName(input.name);
	const removeAvatar = input.remove_avatar === true;
	let cash: number | null = null;
	if (input.cash_balance !== undefined) {
		cash = Number(input.cash_balance);
		if (!Number.isFinite(cash) || cash < 0 || cash > 1e12) {
			throw new TradingError("INVALID_INPUT", "Cash must be a number of rupees, zero or more.");
		}
		cash = Math.round(cash * 100) / 100;
	}
	let hidden: boolean | null = null;
	if (input.hidden_from_leaderboard !== undefined) {
		if (typeof input.hidden_from_leaderboard !== "boolean") {
			throw new TradingError("INVALID_INPUT", "hidden_from_leaderboard must be true or false.");
		}
		hidden = input.hidden_from_leaderboard;
	}
	if (name === null && !removeAvatar && cash === null && hidden === null) {
		throw new TradingError("INVALID_INPUT", "Nothing to update.");
	}

	const rows = await sql`
		WITH avatar AS (
			DELETE FROM user_avatars WHERE ${removeAvatar}::boolean AND user_id = ${userId}
		)
		UPDATE users
		SET
			name = COALESCE(${name}, name),
			image = CASE WHEN ${removeAvatar}::boolean THEN NULL ELSE image END,
			cash_balance = COALESCE(${cash}::numeric, cash_balance),
			hidden_from_leaderboard = COALESCE(${hidden}::boolean, hidden_from_leaderboard),
			"updatedAt" = NOW()
		WHERE id = ${userId}
		RETURNING id
	`;
	if (!rows[0]) {
		throw new TradingError("INVALID_INPUT", "No such user.");
	}

	if (name !== null || removeAvatar) emitToUser(userId, "profileUpdated", {});
	// The player's balance and live portfolio refresh on this.
	if (cash !== null) emitToUser(userId, "walletUpdate", {});
	// Ranks shift for everyone when a player joins or leaves the table.
	if (hidden !== null) await broadcastLeaderboard();
	emitToAdmins("usersChanged", { id: userId });
};
