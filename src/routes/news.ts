import { type Response, Router } from "express";

import {
	addNews,
	deleteNews,
	getAllNews,
	getAllNewsAdmin,
	getNewsById,
	hideNews,
	NewsError,
	releaseNews,
	updateNews,
} from "../controller/news.js";
import { getSessionUser } from "../lib/session.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";

const newsRouter = Router();

newsRouter.use(requireApprovedUser);

const sendError = (res: Response, error: unknown, context: string) => {
	if (error instanceof NewsError) {
		return res.status(error.status).json({ error: error.message });
	}
	console.error(`Error ${context}:`, error);
	res.status(500).json({ error: "Internal Server Error" });
};

const parseId = (value: string | string[]) => {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) {
		throw new NewsError(400, "Invalid news id.");
	}
	return id;
};

newsRouter.get("/getAllNews", async (_, res) => {
	try {
		res.json(await getAllNews());
	} catch (error) {
		sendError(res, error, "fetching news");
	}
});

newsRouter.get("/getAllNewsAdmin", requireAdmin, async (_, res) => {
	try {
		res.json(await getAllNewsAdmin());
	} catch (error) {
		sendError(res, error, "fetching admin news");
	}
});

newsRouter.get("/getNewsById/:id", async (req, res) => {
	try {
		const isAdmin = getSessionUser(res).role === "admin";
		const newsItem = await getNewsById(parseId(req.params.id), isAdmin);
		if (!newsItem) {
			return res.status(404).json({ error: "News not found" });
		}
		res.json(newsItem);
	} catch (error) {
		sendError(res, error, "fetching news by ID");
	}
});

newsRouter.post("/addNews", requireAdmin, async (req, res) => {
	try {
		res.status(201).json(await addNews(req.body?.newsData ?? req.body));
	} catch (error) {
		sendError(res, error, "adding news");
	}
});

newsRouter.put("/updateNews/:id", requireAdmin, async (req, res) => {
	try {
		res.json(
			await updateNews(parseId(req.params.id), req.body?.newsData ?? req.body),
		);
	} catch (error) {
		sendError(res, error, "updating news");
	}
});

/**
 * The only way to release or hide a story after it is saved, so its impact
 * always goes through releaseNews and is applied exactly once.
 */
newsRouter.patch("/updateReleaseStatus/:id", requireAdmin, async (req, res) => {
	const { isReleased } = req.body ?? {};
	if (typeof isReleased !== "boolean") {
		return res.status(400).json({
			error: "isReleased is required and must be a boolean",
		});
	}

	try {
		const id = parseId(req.params.id);
		if (isReleased) {
			await releaseNews(id);
		} else {
			await hideNews(id);
		}
		res.json({ message: "News release status updated successfully" });
	} catch (error) {
		sendError(res, error, "updating news release status");
	}
});

newsRouter.delete("/deleteNews/:id", requireAdmin, async (req, res) => {
	try {
		await deleteNews(parseId(req.params.id));
		res.json({ message: "News deleted successfully" });
	} catch (error) {
		sendError(res, error, "deleting news");
	}
});

export default newsRouter;
