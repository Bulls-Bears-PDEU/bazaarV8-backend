import { Router } from "express";

import { clampLeaders, liveBoardCache } from "../controller/publicBoard.js";

/**
 * Reads that need no session, for screens anyone in the room can see: the
 * live board on the auditorium projector. Read only, and answered from a
 * shared cache, so leaving it open to everyone costs the database nothing
 * extra.
 */
const publicRouter = Router();

// ?limit=N: how many players to rank, at most 30; ?limit=all for every one.
publicRouter.get("/live", async (req, res) => {
	try {
		const board = await liveBoardCache.get(clampLeaders(req.query.limit));
		// Each screen polls; nothing between it and the server should hold an old board.
		res.set("Cache-Control", "no-store");
		res.json(board);
	} catch (error) {
		console.error("Error fetching the live board:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

export default publicRouter;
