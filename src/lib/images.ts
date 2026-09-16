/**
 * Every image a user or organiser uploads is re-encoded here before it is
 * stored, whatever the client claimed to have done to it.
 *
 * The apps already shrink photos in the browser, but that only protects the
 * database from the apps: anything that calls the API directly could store a
 * full-size PNG. Decoding and re-encoding server-side makes the size limit a
 * property of the stored data rather than a promise from the caller, and it
 * also strips EXIF (a phone photo's location included).
 */

import sharp from "sharp";
import { TradingError } from "../trading/errors.js";

/** The largest upload accepted before compression. */
export const IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const IMAGE_UPLOAD_TYPES = [
	"image/webp",
	"image/png",
	"image/jpeg",
] as const;

/** Refuses anything that would decode to more than this many pixels. */
const MAX_INPUT_PIXELS = 40_000_000;

export type CompressedImage = {
	data: Buffer;
	contentType: "image/webp";
	bytes: number;
};

/**
 * Decodes, resizes and re-encodes to WebP.
 *
 * `cover` crops to fill the square (a face in an avatar); `contain` fits the
 * whole image inside it on a transparent ground (a logo must never lose its
 * edges). WebP keeps transparency, which a logo needs and JPEG cannot hold.
 */
export const compressImage = async (
	input: Buffer,
	options: { size: number; fit: "cover" | "contain"; quality?: number },
): Promise<CompressedImage> => {
	if (!Buffer.isBuffer(input) || input.length === 0) {
		throw new TradingError("INVALID_INPUT", "Choose an image to upload.");
	}
	if (input.length > IMAGE_UPLOAD_MAX_BYTES) {
		throw new TradingError(
			"INVALID_INPUT",
			"That image is too large. Use one under 8 MB.",
		);
	}

	let data: Buffer;
	try {
		data = await sharp(input, {
			limitInputPixels: MAX_INPUT_PIXELS,
			failOn: "error",
		})
			// Phone photos store their orientation separately; apply it before the
			// metadata that carries it is dropped.
			.rotate()
			.resize(options.size, options.size, {
				fit: options.fit,
				withoutEnlargement: false,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			})
			.webp({ quality: options.quality ?? 82, effort: 5 })
			.toBuffer();
	} catch {
		// Not an image, a truncated one, or one far too large once decoded.
		throw new TradingError(
			"INVALID_INPUT",
			"That file could not be read as a WebP, PNG or JPEG image.",
		);
	}

	return { data, contentType: "image/webp", bytes: data.length };
};
