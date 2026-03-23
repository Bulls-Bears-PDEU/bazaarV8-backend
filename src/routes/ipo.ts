import { Router } from "express";

import {
	addIpo,
	deleteIpo,
	getAllIpos,
	getIpoById,
	updateIpo,
	updateIpoStatus,
} from "../controller/ipo.js";
import type { IpoStatus } from "../models/ipo.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";

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
		console.error("Error updating IPO:", error);
		res.status(500).json({ error: "Internal Server Error" });
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
		console.error("Error updating IPO status:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

ipoRouter.delete("/deleteIpo/:id", requireAdmin, async (req, res) => {
	const { id } = req.params;
	try {
		await deleteIpo(Number(id));
		res.json({ message: "IPO deleted successfully" });
	} catch (error) {
		console.error("Error deleting IPO:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

export default ipoRouter;
