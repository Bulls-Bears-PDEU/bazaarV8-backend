import { Router } from "express";

import {
	addNews,
	deleteNews,
	getAllNews,
	getAllNewsAdmin,
	getNewsById,
	updateNews,
	updateNewsReleaseStatus,
} from "../controller/news.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import eventEmitter from "../eventEmitter.js";
import { getSessionUser } from "../lib/session.js";

const newsRouter = Router();

newsRouter.use(requireApprovedUser);

newsRouter.get("/getAllNews", async (_, res) => {
	try {
		const news = await getAllNews();
		res.json(news);
	} catch (error) {
		console.error("Error fetching news:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

newsRouter.get("/getAllNewsAdmin", requireAdmin, async (_, res) => {
	try {
		const news = await getAllNewsAdmin();
		res.json(news);
	} catch (error) {
		console.error("Error fetching admin news:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

newsRouter.get("/getNewsById/:id", async (req, res) => {
	const { id } = req.params;
	try {
		const isAdmin = getSessionUser(res).role === "admin";
		const newsItem = await getNewsById(Number(id), isAdmin);
		if (!newsItem) {
			return res.status(404).json({ error: "News not found" });
		}
		res.json(newsItem);
	} catch (error) {
		console.error("Error fetching news by ID:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

newsRouter.post("/addNews", requireAdmin, async (req, res) => {
	const payload = req.body?.newsData ?? req.body;

	if (!payload?.title || !payload?.content || !payload?.release_at) {
		return res.status(400).json({
			error:
				"title, content, and release_at are required. You can send them directly or inside newsData.",
		});
	}

	try {
		await addNews(payload);
		res.json({ message: "News added successfully" });
	} catch (error) {
		console.error("Error adding news:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

newsRouter.put("/updateNews/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	const payload = req.body?.newsData ?? req.body;
	try {
		await updateNews(Number(id), payload);
		res.json({ message: "News updated successfully" });
	} catch (error) {
		console.error("Error updating news:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

newsRouter.patch("/updateReleaseStatus/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	const { isReleased } = req.body;

	if (typeof isReleased !== "boolean") {
		return res.status(400).json({
			error: "isReleased is required and must be a boolean",
		});
	}

	try {
		await updateNewsReleaseStatus(Number(id), isReleased);

		if (isReleased) {
			// Emit an event when news is released
			eventEmitter.emit("newsReleased", { id: Number(id) });
		}
		res.json({ message: "News release status updated successfully" });
	} catch (error) {
		console.error("Error updating news release status:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

newsRouter.delete("/deleteNews/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	try {
		await deleteNews(Number(id));
		res.json({ message: "News deleted successfully" });
	} catch (error) {
		console.error("Error deleting news:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

export default newsRouter;
