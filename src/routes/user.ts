import express, { Router } from "express";
import {
	AVATAR_MAX_BYTES,
	getAvatar,
	removeAvatar,
	setAvatar,
	updateProfile,
} from "../controller/profile.js";
import { approveUser } from "../controller/user.js";
import { getSessionUser } from "../lib/session.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import { sendTradingError } from "../trading/errors.js";

// Users are created by Better Auth's sign-up flow. The old POST /users/create
// was an unauthenticated Clerk-webhook leftover that could not work anyway:
// Better Auth's users table requires email, name and timestamps.
const userRouter = Router();

// Profile photos are public: they appear on the leaderboard, and an <img> on
// another origin does not reliably carry the session cookie. The URL carries a
// version, so a response can be cached for good.
userRouter.get("/avatar/:id", async (req, res) => {
	try {
		const avatar = await getAvatar(String(req.params.id));
		if (!avatar) {
			return res.status(404).end();
		}
		res.set({
			"Content-Type": avatar.contentType,
			"Cache-Control": "public, max-age=31536000, immutable",
			"Last-Modified": avatar.updatedAt.toUTCString(),
			"X-Content-Type-Options": "nosniff",
			// Loaded by the player app and the admin panel, on other origins.
			"Cross-Origin-Resource-Policy": "cross-origin",
		});
		res.send(avatar.data);
	} catch (error) {
		console.error("Error serving avatar:", error);
		res.status(500).end();
	}
});

// Body: the photo's bytes (image/webp, image/png or image/jpeg). The app crops
// and shrinks it first.
userRouter.put(
	"/me/avatar",
	requireApprovedUser,
	express.raw({ type: ["image/webp", "image/png", "image/jpeg"], limit: AVATAR_MAX_BYTES }),
	async (req, res) => {
		try {
			res.json(await setAvatar(getSessionUser(res).id, req.body));
		} catch (error) {
			sendTradingError(res, error);
		}
	},
);

userRouter.delete("/me/avatar", requireApprovedUser, async (_req, res) => {
	try {
		await removeAvatar(getSessionUser(res).id);
		res.json({ image: null });
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { name?, complete_onboarding? }.
userRouter.patch("/me", requireApprovedUser, async (req, res) => {
	try {
		res.json(await updateProfile(getSessionUser(res).id, req.body));
	} catch (error) {
		sendTradingError(res, error);
	}
});

userRouter.put("/approve/:id", requireAdmin, async (req, res) => {
	const userId = Array.isArray(req.params.id)
		? req.params.id[0]
		: req.params.id;

	if (!userId) {
		return res.status(400).json({ error: "User id is required" });
	}

	try {
		await approveUser(userId);
		res.json({ message: "User approved successfully" });
	} catch (error) {
		res.status(500).json({ error: "Failed to approve user" });
	}
});

export default userRouter;
