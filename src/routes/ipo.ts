import express, { Router } from "express";

import {
	addIpo,
	deleteIpo,
	getAllIpos,
	getIpoById,
	parseNewIpo,
	updateIpo,
	updateIpoStatus,
} from "../controller/ipo.js";
import { getIpoLogo, removeIpoLogo, setIpoLogo } from "../controller/ipoLogos.js";
import {
	applyForIpo,
	getIpoApplicationsAdmin,
	getMyApplications,
	runIpoAllotment,
	withdrawIpoApplication,
} from "../controller/ipoApplications.js";
import type { IpoStatus } from "../models/ipo.js";
import { getSessionUser } from "../lib/session.js";
import { IMAGE_UPLOAD_MAX_BYTES, IMAGE_UPLOAD_TYPES } from "../lib/images.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import requireMarketOpen from "../middleware/requireMarketOpen.js";
import requireOnboarded from "../middleware/requireOnboarded.js";
import { sendTradingError, TradingError } from "../trading/errors.js";
import { previewIpoApplication } from "../trading/preview.js";

const ipoRouter = Router();

// Registered before the guard below, as stock logos are: an <img> on another
// origin cannot be relied on to carry a session. Cached for good: the URL
// carries a version, so a new logo is a new URL.
ipoRouter.get("/logo/:id", async (req, res) => {
	try {
		const logo = await getIpoLogo(Number(req.params.id));
		if (!logo) return res.status(404).end();
		res.set({
			"Content-Type": logo.contentType,
			"Cache-Control": "public, max-age=31536000, immutable",
			"Last-Modified": logo.updatedAt.toUTCString(),
			"X-Content-Type-Options": "nosniff",
		});
		res.send(logo.data);
	} catch (error) {
		console.error("Error serving IPO logo:", error);
		res.status(500).end();
	}
});

ipoRouter.use(requireApprovedUser);

ipoRouter.get("/getAllIpos", async (req, res) => {
	const { status, sector, symbol, is_open_to_subscription } = req.query;

	const allowedStatuses: IpoStatus[] = [
		"dormant",
		"upcoming",
		"open",
		"closed",
		"listed",
		"withdrawn",
	];
	if (
		status !== undefined &&
		!allowedStatuses.includes(String(status) as IpoStatus)
	) {
		return res.status(400).json({
			error: "Invalid status filter",
		});
	}

	if (
		is_open_to_subscription !== undefined &&
		is_open_to_subscription !== "true" &&
		is_open_to_subscription !== "false"
	) {
		return res.status(400).json({
			error: "is_open_to_subscription must be true or false",
		});
	}

	try {
		const ipos = await getAllIpos({
			status: status ? (String(status) as IpoStatus) : undefined,
			sector: sector ? String(sector) : undefined,
			symbol: symbol ? String(symbol) : undefined,
			is_open_to_subscription:
				is_open_to_subscription !== undefined
					? is_open_to_subscription === "true"
					: undefined,
			includeDormant: false,
		});
		res.json(ipos);
	} catch (error) {
		console.error("Error fetching IPOs:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

ipoRouter.get("/getAllIposAdmin", requireAdmin, async (req, res) => {
	const { status, sector, symbol, is_open_to_subscription } = req.query;

	const allowedStatuses: IpoStatus[] = [
		"dormant",
		"upcoming",
		"open",
		"closed",
		"listed",
		"withdrawn",
	];
	if (
		status !== undefined &&
		!allowedStatuses.includes(String(status) as IpoStatus)
	) {
		return res.status(400).json({
			error: "Invalid status filter",
		});
	}

	if (
		is_open_to_subscription !== undefined &&
		is_open_to_subscription !== "true" &&
		is_open_to_subscription !== "false"
	) {
		return res.status(400).json({
			error: "is_open_to_subscription must be true or false",
		});
	}

	try {
		const ipos = await getAllIpos({
			status: status ? (String(status) as IpoStatus) : undefined,
			sector: sector ? String(sector) : undefined,
			symbol: symbol ? String(symbol) : undefined,
			is_open_to_subscription:
				is_open_to_subscription !== undefined
					? is_open_to_subscription === "true"
					: undefined,
			includeDormant: true,
		});
		res.json(ipos);
	} catch (error) {
		console.error("Error fetching admin IPOs:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

ipoRouter.get("/getIpoById/:id", async (req, res) => {
	const { id } = req.params;
	try {
		const ipo = await getIpoById(Number(id), false);
		if (!ipo) {
			return res.status(404).json({ error: "IPO not found" });
		}
		res.json(ipo);
	} catch (error) {
		console.error("Error fetching IPO by ID:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

ipoRouter.get("/getIpoByIdAdmin/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	try {
		const ipo = await getIpoById(Number(id), true);
		if (!ipo) {
			return res.status(404).json({ error: "IPO not found" });
		}
		res.json(ipo);
	} catch (error) {
		console.error("Error fetching admin IPO by ID:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Fields may be sent directly or inside ipoData. Answers { message, id }.
ipoRouter.post("/addIpo", requireAdmin, async (req, res) => {
	const payload = req.body?.ipoData ?? req.body;
	try {
		const ipo = parseNewIpo({
			...payload,
			status:
				payload?.status ??
				(payload?.store_as_dormant === true ? "dormant" : "upcoming"),
		});
		const id = await addIpo(ipo);
		res.json({ message: "IPO added successfully", id });
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: the image's bytes (webp, png or jpeg). Re-encoded before it is stored.
ipoRouter.put(
	"/:id/logo",
	requireAdmin,
	express.raw({ type: [...IMAGE_UPLOAD_TYPES], limit: IMAGE_UPLOAD_MAX_BYTES }),
	async (req, res) => {
		try {
			res.json(await setIpoLogo(ipoIdParam(req.params.id), req.body));
		} catch (error) {
			sendTradingError(res, error);
		}
	},
);

ipoRouter.delete("/:id/logo", requireAdmin, async (req, res) => {
	try {
		await removeIpoLogo(ipoIdParam(req.params.id));
		res.status(204).end();
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: any of the fields addIpo takes, except status. Answers with the IPO.
ipoRouter.put("/updateIpo/:id", requireAdmin, async (req, res) => {
	const payload = req.body?.ipoData ?? req.body;
	try {
		const id = ipoIdParam(req.params.id);
		await updateIpo(id, payload);
		res.json(await getIpoById(id, true));
	} catch (error) {
		sendTradingError(res, error);
	}
});

ipoRouter.patch("/updateIpoStatus/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	const { status, is_open_to_subscription, volatility } = req.body;

	const allowedStatuses: IpoStatus[] = [
		"dormant",
		"upcoming",
		"open",
		"closed",
		"listed",
		"withdrawn",
	];
	if (!allowedStatuses.includes(status)) {
		return res.status(400).json({
			error: "status is required and must be a valid IPO status",
		});
	}

	if (
		is_open_to_subscription !== undefined &&
		typeof is_open_to_subscription !== "boolean"
	) {
		return res.status(400).json({
			error: "is_open_to_subscription must be a boolean when provided",
		});
	}

	if (volatility !== undefined && typeof volatility !== "number") {
		return res.status(400).json({
			error: "volatility must be a number when provided (used when listing IPO)",
		});
	}

	try {
		await updateIpoStatus(
			Number(id),
			status,
			is_open_to_subscription,
			volatility,
		);
		res.json({ message: "IPO status updated successfully" });
	} catch (error) {
		// e.g. ALLOTMENT_PENDING when listing before allotment has run.
		sendTradingError(res, error);
	}
});

ipoRouter.delete("/deleteIpo/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	try {
		await deleteIpo(Number(id));
		res.json({ message: "IPO deleted successfully" });
	} catch (error) {
		sendTradingError(res, error);
	}
});

const ipoIdParam = (value: unknown) => {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) {
		throw new TradingError("IPO_NOT_FOUND", "IPO not found.");
	}
	return id;
};

// Body: { lots, bid_price? }. bid_price defaults to the top of the band.
ipoRouter.post("/applyForIpo/:id", requireOnboarded, requireMarketOpen, async (req, res) => {
	try {
		const lots = Number(req.body?.lots);
		if (!Number.isInteger(lots) || lots <= 0) {
			throw new TradingError(
				"INVALID_QUANTITY",
				"lots must be a whole number above zero.",
			);
		}
		const bid =
			req.body?.bid_price === undefined ? undefined : Number(req.body.bid_price);
		if (bid !== undefined && (!Number.isFinite(bid) || bid <= 0)) {
			throw new TradingError("INVALID_INPUT", "bid_price must be a price.");
		}
		const result = await applyForIpo(
			getSessionUser(res).id,
			ipoIdParam(req.params.id),
			lots,
			bid,
		);
		res.status(201).json(result);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { lots, bid_price? }. What applying would hold back from cash, or why
// it would be refused, without applying.
ipoRouter.post("/previewApplication/:id", async (req, res) => {
	try {
		const lots = Number(req.body?.lots);
		if (!Number.isInteger(lots) || lots <= 0) {
			throw new TradingError("INVALID_QUANTITY", "lots must be a whole number above zero.");
		}
		const bid = req.body?.bid_price === undefined ? undefined : Number(req.body.bid_price);
		if (bid !== undefined && (!Number.isFinite(bid) || bid <= 0)) {
			throw new TradingError("INVALID_INPUT", "bid_price must be a price.");
		}
		res.json(await previewIpoApplication(getSessionUser(res).id, ipoIdParam(req.params.id), lots, bid));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Refunds the whole application. Only while the IPO is open.
ipoRouter.delete("/withdrawApplication/:id", async (req, res) => {
	try {
		res.json(
			await withdrawIpoApplication(
				getSessionUser(res).id,
				ipoIdParam(req.params.id),
			),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

ipoRouter.get("/getMyApplications", async (_req, res) => {
	try {
		res.json(await getMyApplications(getSessionUser(res).id));
	} catch (error) {
		sendTradingError(res, error);
	}
});

ipoRouter.get("/getIpoApplicationsAdmin/:id", requireAdmin, async (req, res) => {
	try {
		res.json(await getIpoApplicationsAdmin(ipoIdParam(req.params.id)));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { allotment_price? }, defaulting to the top of the band. The IPO must
// be closed; runs once.
ipoRouter.post("/runAllotment/:id", requireAdmin, async (req, res) => {
	try {
		const price =
			req.body?.allotment_price === undefined
				? undefined
				: Number(req.body.allotment_price);
		if (price !== undefined && (!Number.isFinite(price) || price <= 0)) {
			throw new TradingError("INVALID_INPUT", "allotment_price must be a price.");
		}
		res.json(await runIpoAllotment(ipoIdParam(req.params.id), price));
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default ipoRouter;
