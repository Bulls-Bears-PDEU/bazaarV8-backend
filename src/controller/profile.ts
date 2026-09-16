import sql from "../database/database.js";
import { compressImage } from "../lib/images.js";
import { emitToAdmins, emitToUser } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";

/**
 * A player's own profile: their display name, their photo, and finishing the
 * first-login onboarding. Photos are stored in user_avatars and served from a
 * versioned URL, so browsers can cache them forever and a new photo is simply
 * a new URL.
 */

export const NAME_MIN = 2;
export const NAME_MAX = 60;
// Stored avatars are this many pixels square. The browser already sends one,
// but the server re-encodes to it regardless, so a direct upload cannot store
// anything larger.
export const AVATAR_SIZE = 256;

export type ProfileImageType = "image/webp" | "image/png" | "image/jpeg";

/** Trims, collapses runs of spaces and rejects names that are too short, too long or unprintable. */
export const normalizeName = (value: unknown) => {
	const name =
		typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	// Control characters, and the invisible ones that make two names look alike.
	if (/[\p{Cc}\p{Cf}]/u.test(name)) {
		throw new TradingError(
			"INVALID_INPUT",
			"Your name can only contain visible characters.",
		);
	}
	if (name.length < NAME_MIN || name.length > NAME_MAX) {
		throw new TradingError(
			"INVALID_INPUT",
			`Your name must be between ${NAME_MIN} and ${NAME_MAX} characters.`,
		);
	}
	return name;
};

/** Trusts the file's first bytes, not the Content-Type it arrived with. */
const sniffImageType = (bytes: Buffer): ProfileImageType | null => {
	if (
		bytes.length >= 12 &&
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	if (
		bytes.length >= 8 &&
		bytes
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	return null;
};

/**
 * Stored as a path, not a full URL. BACKEND_URL is often a tunnel that changes
 * on every restart, so a full URL stops loading as soon as it does; each app
 * resolves the path against the API address it actually reaches.
 */
const avatarUrl = (userId: string, version: number) =>
	`/users/avatar/${encodeURIComponent(userId)}?v=${version}`;

/** Tells the player's other tabs and the admin panel that the profile changed. */
const announce = (userId: string) => {
	emitToUser(userId, "profileUpdated", {});
	emitToAdmins("usersChanged", { id: userId });
};

export const getAvatar = async (userId: string) => {
	const rows = await sql`
		SELECT content_type, data, updated_at
		FROM user_avatars
		WHERE user_id = ${userId}
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

export const setAvatar = async (userId: string, body: unknown) => {
	if (!Buffer.isBuffer(body) || !sniffImageType(body)) {
		throw new TradingError("INVALID_INPUT", "Use a WebP, PNG or JPEG photo.");
	}
	// Re-encoded whatever arrived: typically ~10 KB, never the upload's own size.
	const { data, contentType: type } = await compressImage(body, {
		size: AVATAR_SIZE,
		fit: "cover",
	});

	const version = Date.now();
	const image = avatarUrl(userId, version);
	await sql`
		WITH saved AS (
			INSERT INTO user_avatars (user_id, content_type, data, updated_at)
			-- Sent as hex text and decoded here, which every driver passes through intact.
			VALUES (${userId}, ${type}, decode(${data.toString("hex")}, 'hex'), CURRENT_TIMESTAMP)
			ON CONFLICT (user_id) DO UPDATE
			SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
			RETURNING user_id
		)
		UPDATE users SET image = ${image}, "updatedAt" = NOW()
		WHERE id = (SELECT user_id FROM saved)
	`;
	announce(userId);
	return { image };
};

export const removeAvatar = async (userId: string) => {
	await sql`
		WITH removed AS (DELETE FROM user_avatars WHERE user_id = ${userId})
		UPDATE users SET image = NULL, "updatedAt" = NOW() WHERE id = ${userId}
	`;
	announce(userId);
};

/**
 * Updates the display name and, when asked, marks onboarding done. Finishing
 * onboarding requires a name, which the dialog always sends.
 */
export const updateProfile = async (userId: string, body: unknown) => {
	const input = (body ?? {}) as Record<string, unknown>;
	const name = input.name === undefined ? null : normalizeName(input.name);
	const complete = input.complete_onboarding === true;
	if (complete && name === null) {
		throw new TradingError(
			"INVALID_INPUT",
			"Confirm your name to finish setting up.",
		);
	}
	if (name === null && !complete) {
		throw new TradingError("INVALID_INPUT", "Nothing to update.");
	}

	const rows = await sql`
		UPDATE users
		SET
			name = COALESCE(${name}, name),
			onboarded_at = CASE WHEN ${complete}::boolean THEN COALESCE(onboarded_at, NOW()) ELSE onboarded_at END,
			"updatedAt" = NOW()
		WHERE id = ${userId}
		RETURNING id, name, image, onboarded_at
	`;
	announce(userId);
	return rows[0];
};
