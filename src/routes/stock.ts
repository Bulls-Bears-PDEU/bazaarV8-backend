import { Router } from "express";

import {
	addStock,
	addStockOHLC,
	getAllStocks,
	getCurrentPrice,
	getCurrentPricesForAllStocks,
	getOHLCByStockId,
	getStockById,
	updateStock,
} from "../controller/stock.js";

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

stockRouter.get("/getCurrentPricesForAllStocks", async (_, res) => {
	try {
		const prices = await getCurrentPricesForAllStocks();
		res.json(prices);
	} catch (error) {
		console.error("Error fetching current prices:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.get("/getCurrentPrice/:id", async (req, res) => {
	const { id } = req.params;
	const { enableIndicator } = req.query; // Include positive or negative indicator (showing stock value increased or decrease)in the response
	try {
		const currentPrice = await getCurrentPrice(Number(id));
		if (currentPrice === undefined) {
			return res.status(404).json({ error: "Stock not found" });
		}

		if (enableIndicator === "true") {
			const ohlcData = await getOHLCByStockId(Number(id));
			const latestTwoEntries = ohlcData.slice(-2);
			if (latestTwoEntries.length === 2) {
				const priceChange =
					latestTwoEntries[1].close_price - latestTwoEntries[0].close_price;
				const indicator =
					priceChange > 0 ? "up" : priceChange < 0 ? "down" : "neutral";
				return res.json({
					price: currentPrice,
					indicator,
					priceChange: priceChange,
				});
			} else {
				return res.json({ price: currentPrice, indicator: "neutral" });
			}
		}

		return res.json({ price: currentPrice });
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

stockRouter.put("/updateStock/:id", async (req, res) => {
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

stockRouter.post("/addStock", async (req, res) => {
	const { stockData, initPrice } = req.body;
	try {
		await addStock(stockData, initPrice);
		res.json({ message: "Stock added successfully" });
	} catch (error) {
		console.error("Error adding stock:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

stockRouter.post("/addStockOHLC/:id", async (req, res) => {
	const { id } = req.params;
	const ohlcData = req.body;
	try {
		await addStockOHLC(Number(id), ohlcData);
		res.json({ message: "Stock OHLC data added successfully" });
	} catch (error) {
		console.error("Error adding stock OHLC data:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});


export default stockRouter;
