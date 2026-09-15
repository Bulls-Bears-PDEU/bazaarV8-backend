import { Router } from "express";

import {
	addIpo,
	deleteIpo,
	getAllIpos,
	getIpoById,
	updateIpo,
	updateIpoStatus,
} from "../controller/ipo.js";
import {
	applyForIpo,
	getIpoApplicationsAdmin,
	getMyApplications,
	runIpoAllotment,
	withdrawIpoApplication,
} from "../controller/ipoApplications.js";
import type { IpoStatus } from "../models/ipo.js";
import { getSessionUser } from "../lib/session.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import requireMarketOpen from "../middleware/requireMarketOpen.js";
import { sendTradingError, TradingError } from "../trading/errors.js";
import { previewIpoApplication } from "../trading/preview.js";

const ipoRouter = Router();

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

ipoRouter.post("/addIpo", requireAdmin, async (req, res) => {
	const payload = req.body?.ipoData ?? req.body;
	const storeAsDormant = payload?.store_as_dormant === true;
	const payloadWithDormantControl = {
		...payload,
		status: payload?.status ?? (storeAsDormant ? "dormant" : "upcoming"),
		is_open_to_subscription: storeAsDormant
			? false
			: payload?.is_open_to_subscription,
	};

	if (
		!payload?.name ||
		!payload?.symbol ||
		!payload?.open_date ||
		!payload?.close_date ||
		!payload?.allotment_date
	) {
		return res.status(400).json({
			error:
				"name, symbol, open_date, close_date, and allotment_date are required. You can send them directly or inside ipoData.",
		});
	}

	try {
		await addIpo(payloadWithDormantControl);
		res.json({ message: "IPO added successfully" });
	} catch (error) {
		console.error("Error adding IPO:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

ipoRouter.put("/updateIpo/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	const payload = req.body?.ipoData ?? req.body;
	try {
		await updateIpo(Number(id), payload);
		res.json({ message: "IPO updated successfully" });
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
ipoRouter.post("/applyForIpo/:id", requireMarketOpen, async (req, res) => {
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
