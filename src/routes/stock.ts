import { Router } from "express";

import {
	addStock,
	getAllStocks,
	getCurrentPrice,
	getOHLCByStockId,
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

stockRouter.get("/getOHLCByStockId/:id", async (req, res) => {
	const { id } = req.params;
	try {
		const ohlcData = await getOHLCByStockId(Number(id));
		res.json(ohlcData);
	} catch (error) {
		console.error("Error fetching OHLC data:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.get("/getCurrentPrice/:id", async (req, res) => {
	const { id } = req.params;
	try {
		const currentPrice = await getCurrentPrice(Number(id));
		if (currentPrice !== undefined) {
			res.json({ currentPrice });
		} else {
			res.status(404).json({ error: "Stock not found" });
		}
	} catch (error) {
		console.error("Error fetching current price:", error);
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
	const { stockData, stockOHLCData } = req.body;
	try {
		await updateStock(Number(id), stockData, stockOHLCData);
		res.json({ message: "Stock updated successfully" });
	} catch (error) {
		console.error("Error updating stock:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.post("/addStock", requireAuth(), async (req, res) => {
	const { stockData, initPrice } = req.body;
	try {
		await addStock(stockData, initPrice);
		res.json({ message: "Stock added successfully" });
	} catch (error) {
		console.error("Error adding stock:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

export default stockRouter;
