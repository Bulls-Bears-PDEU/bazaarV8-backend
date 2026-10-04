/**
 * Sponsor ads: one per slot the player app reserves for them. Uploaded by an
 * organiser, stored in the database and served by the backend, exactly as
 * stock logos are, so a new ad needs no redeploy of either app.
 */

import sql from "../database/database.js";
import { compressImage } from "../lib/images.js";
import { emitToMarket } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";

export type AdFormat = "leaderboard" | "rectangle";

/**
 * The slots the player app places, by the name it gives them. Sizes are the
 * standard IAB ones the slots are laid out for; images are stored at twice
 * that so they stay sharp on high density screens.
 */
export const AD_SLOTS = {
	"news-top": { label: "News article: top banner", format: "leaderboard" },
	"news-in-article": {
		label: "News article: in the story",
		format: "leaderboard",
	},
	"news-sidebar-1": {
		label: "News article: sidebar, upper",
		format: "rectangle",
	},
	"news-sidebar-2": {
		label: "News article: sidebar, lower",
		format: "rectangle",
	},
	"news-list": {
		label: "News page: sidebar",
		format: "rectangle",
	},
	"market-paused": {
		label: "Market paused screen",
		format: "rectangle",
	},
} as const satisfies Record<string, { label: string; format: AdFormat }>;

export type AdSlot = keyof typeof AD_SLOTS;

export const AD_SIZES: Record<AdFormat, { width: number; height: number }> = {
	leaderboard: { width: 728, height: 90 },
	rectangle: { width: 300, height: 250 },
};

const SPONSOR_MAX_LENGTH = 100;
const LINK_MAX_LENGTH = 2048;

const SLOT_NAMES: ReadonlySet<string> = new Set(Object.keys(AD_SLOTS));

export const isAdSlot = (slot: string): slot is AdSlot => SLOT_NAMES.has(slot);

const requireSlot = (slot: string): AdSlot => {
	if (!isAdSlot(slot))
		throw new TradingError("AD_NOT_FOUND", "There is no ad slot by that name.");
	return slot;
};

/**
 * Stored as a path, not a full URL, for the same reason as logos: each app
 * resolves it against the API address it actually reaches. The version makes
 * a new image a new URL, so the image itself can be cached for good.
 */
const imageUrl = (slot: string, updatedAt: Date | string) =>
	`/ads/image/${slot}?v=${new Date(updatedAt).getTime()}`;

type AdRow = {
	slot: string;
	sponsor: string;
	link_url: string | null;
	is_active: boolean;
	updated_at: Date | string;
};

const toAd = (row: AdRow) => ({
	slot: row.slot,
	sponsor: row.sponsor,
	link_url: row.link_url,
	is_active: row.is_active,
	image_url: imageUrl(row.slot, row.updated_at),
	updated_at: new Date(row.updated_at).toISOString(),
});

/** The organisers' switch for every ad at once. On until it is turned off. */
const adsEnabled = async () => {
	const rows = await sql`SELECT enabled FROM ad_settings WHERE id = 1`;
	return rows[0] ? Boolean(rows[0].enabled) : true;
};

/**
 * What players see. While ads are switched off `enabled` is false and the app
 * shows no ad boxes at all; otherwise a slot without a live ad keeps its
 * placeholder.
 */
export const getActiveAds = async () => {
	const [enabled, rows] = await Promise.all([
		adsEnabled(),
		sql`
			SELECT slot, sponsor, link_url, is_active, updated_at
			FROM ads WHERE is_active
		`.then((rows) => rows as AdRow[]),
	]);
	return {
		enabled,
		ads: enabled ? rows.filter((row) => isAdSlot(row.slot)).map(toAd) : [],
	};
};

/** Every slot, with its size and its ad if it has one, for the admin panel. */
export const getAdsAdmin = async () => {
	const [enabled, rows] = await Promise.all([
		adsEnabled(),
		sql`
			SELECT slot, sponsor, link_url, is_active, updated_at FROM ads
		`.then((rows) => rows as AdRow[]),
	]);
	const bySlot = new Map(rows.map((row) => [row.slot, row]));
	return {
		enabled,
		slots: Object.entries(AD_SLOTS).map(([slot, { label, format }]) => {
			const row = bySlot.get(slot);
			return {
				slot,
				label,
				format,
				...AD_SIZES[format],
				ad: row ? toAd(row) : null,
			};
		}),
	};
};

/** Shows or hides every ad, placeholders included, without touching any. */
export const setAdsEnabled = async (body: unknown) => {
	const enabled = (body as { enabled?: unknown } | undefined)?.enabled;
	if (typeof enabled !== "boolean") {
		throw new TradingError("INVALID_INPUT", "enabled must be true or false.");
	}
	await sql`
		INSERT INTO ad_settings (id, enabled) VALUES (1, ${enabled})
		ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled
	`;
	emitToMarket("adsChanged", {});
	return { enabled };
};

export const getAdImage = async (slot: string) => {
	if (!isAdSlot(slot)) return null;
	const rows = await sql`
		SELECT content_type, data, updated_at FROM ads WHERE slot = ${slot}
	`;
	const row = rows[0];
	if (!row) return null;
	return {
		contentType: String(row.content_type),
		// Drivers hand BYTEA back as bytes, or as hex text ("\x89504e...").
		data:
			row.data instanceof Uint8Array
				? Buffer.from(row.data)
				: Buffer.from(String(row.data).replace(/^\\x/, ""), "hex"),
		updatedAt: new Date(row.updated_at as string),
	};
};

/**
 * Stores a slot's image, re-encoded to a WebP at twice the slot's size. The
 * whole image is kept, on a transparent ground, so a banner that is not quite
 * the right shape is letterboxed rather than cropped. Uploading to an empty
 * slot creates its ad, live straight away.
 */
export const setAdImage = async (slotName: string, body: unknown) => {
	const slot = requireSlot(slotName);
	const { width, height } = AD_SIZES[AD_SLOTS[slot].format];

	const { data, contentType, bytes } = await compressImage(body as Buffer, {
		width: width * 2,
		height: height * 2,
		fit: "contain",
		quality: 85,
	});

	const rows = (await sql`
		INSERT INTO ads (slot, content_type, data, updated_at)
		-- Sent as hex text and decoded here, which every driver passes through intact.
		VALUES (${slot}, ${contentType}, decode(${data.toString("hex")}, 'hex'), CURRENT_TIMESTAMP)
		ON CONFLICT (slot) DO UPDATE
		SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
		RETURNING slot, sponsor, link_url, is_active, updated_at
	`) as AdRow[];

	emitToMarket("adsChanged", { slot });
	return { ad: toAd(rows[0]), bytes };
};

const parseLink = (value: unknown) => {
	if (value === null || value === "") return null;
	if (typeof value !== "string" || value.length > LINK_MAX_LENGTH) {
		throw new TradingError("INVALID_INPUT", "The link must be a web address.");
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new TradingError(
			"INVALID_INPUT",
			"The link must be a full web address, starting with https://.",
		);
	}
	// Anything else (javascript:, data:) would run in the player's page.
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new TradingError(
			"INVALID_INPUT",
			"The link must start with https:// or http://.",
		);
	}
	return url.toString();
};

/** Changes a slot's sponsor name, link or whether it is live. */
export const updateAd = async (slotName: string, body: unknown) => {
	const slot = requireSlot(slotName);
	const input = (body ?? {}) as Record<string, unknown>;

	let sponsor: string | undefined;
	if (input.sponsor !== undefined) {
		if (
			typeof input.sponsor !== "string" ||
			input.sponsor.trim().length > SPONSOR_MAX_LENGTH
		) {
			throw new TradingError(
				"INVALID_INPUT",
				`The sponsor name must be at most ${SPONSOR_MAX_LENGTH} characters.`,
			);
		}
		sponsor = input.sponsor.trim();
	}
	const linkGiven = input.link_url !== undefined;
	const link = linkGiven ? parseLink(input.link_url) : null;
	let isActive: boolean | undefined;
	if (input.is_active !== undefined) {
		if (typeof input.is_active !== "boolean") {
			throw new TradingError(
				"INVALID_INPUT",
				"is_active must be true or false.",
			);
		}
		isActive = input.is_active;
	}

	const rows = (await sql`
		UPDATE ads SET
			sponsor = COALESCE(${sponsor ?? null}::text, sponsor),
			link_url = CASE WHEN ${linkGiven}::boolean THEN ${link}::text ELSE link_url END,
			is_active = COALESCE(${isActive ?? null}::boolean, is_active)
		WHERE slot = ${slot}
		RETURNING slot, sponsor, link_url, is_active, updated_at
	`) as AdRow[];
	if (rows.length === 0) {
		throw new TradingError(
			"AD_NOT_FOUND",
			"Upload an image for this slot first.",
		);
	}

	emitToMarket("adsChanged", { slot });
	return toAd(rows[0]);
};

/** Empties a slot; players see its placeholder again. */
export const removeAd = async (slotName: string) => {
	const slot = requireSlot(slotName);
	await sql`DELETE FROM ads WHERE slot = ${slot}`;
	emitToMarket("adsChanged", { slot });
};
