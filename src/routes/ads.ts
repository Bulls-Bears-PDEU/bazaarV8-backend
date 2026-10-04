import express, { Router } from "express";

import {
	getAdImage,
	getAdsAdmin,
	removeAd,
	setAdImage,
	setAdsEnabled,
	updateAd,
} from "../controller/ads.js";
import { IMAGE_UPLOAD_MAX_BYTES, IMAGE_UPLOAD_TYPES } from "../lib/images.js";
import { adsCache } from "../lib/sharedReads.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import { sendTradingError } from "../trading/errors.js";

const adRouter = Router();

// Registered before the guard below, as logos are: an <img> on another origin
// cannot be relied on to carry a session. Cached for good: the URL carries a
// version, so a new image is a new URL.
adRouter.get("/image/:slot", async (req, res) => {
	try {
		const image = await getAdImage(String(req.params.slot));
		if (!image) return res.status(404).end();
		res.set({
			"Content-Type": image.contentType,
			"Cache-Control": "public, max-age=31536000, immutable",
			"Last-Modified": image.updatedAt.toUTCString(),
			"X-Content-Type-Options": "nosniff",
			"Cross-Origin-Resource-Policy": "cross-origin",
		});
		res.send(image.data);
	} catch (error) {
		console.error("Error serving ad image:", error);
		res.status(500).end();
	}
});

adRouter.use(requireApprovedUser);

// { enabled, ads }: live ads for the player app. Slots without one are left
// out; while `enabled` is false the app shows no ad boxes at all.
adRouter.get("/getAds", async (_req, res) => {
	try {
		res.json(await adsCache.get(undefined));
	} catch (error) {
		console.error("Error fetching ads:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// { enabled, slots }: every slot, with its size and its ad if it has one.
adRouter.get("/getAdsAdmin", requireAdmin, async (_req, res) => {
	try {
		res.json(await getAdsAdmin());
	} catch (error) {
		console.error("Error fetching ads:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Body: { enabled }. Shows or hides every ad at once. Registered before the
// /:slot routes so the name is never read as a slot.
adRouter.patch("/setAdsEnabled", requireAdmin, async (req, res) => {
	try {
		res.json(await setAdsEnabled(req.body));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: the image's bytes (webp, png or jpeg). Re-encoded before it is stored.
// Uploading to an empty slot creates its ad.
adRouter.put(
	"/:slot/image",
	requireAdmin,
	express.raw({ type: [...IMAGE_UPLOAD_TYPES], limit: IMAGE_UPLOAD_MAX_BYTES }),
	async (req, res) => {
		try {
			res.json(await setAdImage(String(req.params.slot), req.body));
		} catch (error) {
			sendTradingError(res, error);
		}
	},
);

// Body: any of { sponsor, link_url, is_active }.
adRouter.patch("/:slot", requireAdmin, async (req, res) => {
	try {
		res.json(await updateAd(String(req.params.slot), req.body));
	} catch (error) {
		sendTradingError(res, error);
	}
});

adRouter.delete("/:slot", requireAdmin, async (req, res) => {
	try {
		await removeAd(String(req.params.slot));
		res.status(204).end();
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default adRouter;
