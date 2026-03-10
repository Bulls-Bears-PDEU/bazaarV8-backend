import { Router } from "express";

import {
	addStock,
	getAllStocks,
	getStockById,
	updateStock,
} from "../controller/stock.js";
import { requireAuth } from "@clerk/express";

const stockRouter = Router();

stockRouter.get("/getAllStocks", async (_, res) => {
	try {
		const stocks = await getAllStocks();
		res.json(stocks);
	} catch (error) {
		console.error("Error fetching stocks:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.get("/getStockById/:id", async (req, res) => {
	const { id } = req.params;
	try {
		const stock = await getStockById(Number(id));
		if (stock) {
			res.json(stock);
		} else {
			res.status(404).json({ error: "Stock not found" });
		}
	} catch (error) {
		console.error("Error fetching stock by ID:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.put("/updateStock/:id", requireAuth(), async (req, res) => {
	const { id } = req.params;
	const stockData = req.body;
	try {
		await updateStock(Number(id), stockData);
		res.json({ message: "Stock updated successfully" });
	} catch (error) {
		console.error("Error updating stock:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.post("/addStock", requireAuth(), async (req, res) => {
	const stockData = req.body;
	try {
		await addStock(stockData);
		res.json({ message: "Stock added successfully" });
	} catch (error) {
		console.error("Error adding stock:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

export default stockRouter;
