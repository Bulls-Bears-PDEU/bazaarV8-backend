/**
 * Stock logos: uploaded by an organiser, stored in the database and served by
 * the backend, exactly as player avatars are. Keeping them out of either app's
 * static files means both apps show the same picture and a new logo needs no
 * redeploy.
 */

import sql from "../database/database.js";
import { compressImage } from "../lib/images.js";
import { emitToMarket } from "../realtime/emitter.js";
import { TradingError } from "../trading/errors.js";

/** Stored logos are this many pixels square. */
export const LOGO_SIZE = 256;

/**
 * Stored as a path, not a full URL. The backend's idea of its own address
 * (BACKEND_URL, often a tunnel that changes every restart) is not necessarily
 * how an app reaches it, so each app resolves the path against its own API
 * address instead. A full URL baked into the row breaks the moment either moves.
 */
const logoUrl = (stockId: number, version: number) =>
	`/stocks/logo/${stockId}?v=${version}`;

export const getStockLogo = async (stockId: number) => {
	const rows = await sql`
		SELECT content_type, data, updated_at FROM stock_logos WHERE stock_id = ${stockId}
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
 * Stores a logo, re-encoded to a 256px WebP on a transparent ground so no part
 * of the mark is cropped away. Returns the URL the apps should show.
 */
export const setStockLogo = async (stockId: number, body: unknown) => {
	const exists = await sql`SELECT 1 FROM stocks WHERE id = ${stockId}`;
	if (exists.length === 0)
		throw new TradingError("STOCK_NOT_FOUND", "Stock not found.");

	const { data, contentType, bytes } = await compressImage(body as Buffer, {
		size: LOGO_SIZE,
		fit: "contain",
	});
	const version = Date.now();
	const url = logoUrl(stockId, version);

	await sql`
		WITH saved AS (
			INSERT INTO stock_logos (stock_id, content_type, data, updated_at)
			-- Sent as hex text and decoded here, which every driver passes through intact.
			VALUES (${stockId}, ${contentType}, decode(${data.toString("hex")}, 'hex'), CURRENT_TIMESTAMP)
			ON CONFLICT (stock_id) DO UPDATE
			SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
			RETURNING stock_id
		)
		UPDATE stocks SET logo_url = ${url} WHERE id = (SELECT stock_id FROM saved)
	`;
	// Every screen that lists stocks shows the logo, so everyone refetches.
	emitToMarket("stocksChanged", { id: stockId });
	return { logo_url: url, bytes };
};

export const removeStockLogo = async (stockId: number) => {
	await sql`
		WITH removed AS (DELETE FROM stock_logos WHERE stock_id = ${stockId})
		UPDATE stocks SET logo_url = NULL WHERE id = ${stockId}
	`;
	emitToMarket("stocksChanged", { id: stockId });
};
