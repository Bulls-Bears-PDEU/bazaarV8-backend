/**
 * IPO logos: stored and served exactly as stock logos are, so players see the
 * company's mark while it is still an IPO. Listing copies the logo onto the
 * new stock (bazaar_list_ipo), so it carries over without a second upload.
 */

import sql from "../database/database.js";
import { compressImage } from "../lib/images.js";
import { emitToMarket } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";
import { LOGO_SIZE } from "./stockLogos.js";

// A path, not a full URL, for the same reason as stock logos (see stockLogos.ts).
const logoUrl = (ipoId: number, version: number) =>
	`/ipos/logo/${ipoId}?v=${version}`;

export const getIpoLogo = async (ipoId: number) => {
	const rows = await sql`
		SELECT content_type, data, updated_at FROM ipo_logos WHERE ipo_id = ${ipoId}
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

/** Stores a logo, re-encoded the way stock logos are. */
export const setIpoLogo = async (ipoId: number, body: unknown) => {
	const exists = await sql`SELECT 1 FROM ipo WHERE id = ${ipoId}`;
	if (exists.length === 0)
		throw new TradingError("IPO_NOT_FOUND", "IPO not found.");

	const { data, contentType, bytes } = await compressImage(body as Buffer, {
		size: LOGO_SIZE,
		fit: "contain",
	});
	const url = logoUrl(ipoId, Date.now());

	await sql`
		WITH saved AS (
			INSERT INTO ipo_logos (ipo_id, content_type, data, updated_at)
			-- Sent as hex text and decoded here, which every driver passes through intact.
			VALUES (${ipoId}, ${contentType}, decode(${data.toString("hex")}, 'hex'), CURRENT_TIMESTAMP)
			ON CONFLICT (ipo_id) DO UPDATE
			SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
			RETURNING ipo_id
		)
		UPDATE ipo SET logo_url = ${url} WHERE id = (SELECT ipo_id FROM saved)
	`;
	emitToMarket("iposChanged", { id: ipoId });
	return { logo_url: url, bytes };
};

export const removeIpoLogo = async (ipoId: number) => {
	await sql`
		WITH removed AS (DELETE FROM ipo_logos WHERE ipo_id = ${ipoId})
		UPDATE ipo SET logo_url = NULL WHERE id = ${ipoId}
	`;
	emitToMarket("iposChanged", { id: ipoId });
};
