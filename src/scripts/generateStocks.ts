import sql from "../database/database.js";
import type { StockOHLC } from "../models/stock.js";
import { generateStockPrice } from "../stockEngine.js";

const sectors = [
	"Technology",
	"Healthcare",
	"Financials",
	"Consumer Discretionary",
	"Consumer Staples",
	"Energy",
	"Industrials",
	"Materials",
	"Utilities",
	"Real Estate",
];

const generateStocks = async () => {
	const count = Number(process.argv.slice(2)[0]) || 100;
	const ohlcCount = Number(process.argv.slice(2)[1]) || 30; // Number of OHLC entries to generate for each stock, default is 30

	console.log(
		`Generating ${count} stocks with ${ohlcCount} OHLC entries each...`,
	);

	for (let i = 1; i <= count; i++) {
		const symbol = `STK${i}`;
		const name = `Stock ${i}`;
		const volatility = parseFloat((Math.random() * 50 + 1).toFixed(2)); // Random volatility between 1% and 50%
		const sector = sectors[Math.floor(Math.random() * sectors.length)];

		await sql`
			INSERT INTO stocks (id, symbol, name, volatility, sector)
			VALUES (${i}, ${symbol}, ${name}, ${volatility}, ${sector})
			ON CONFLICT (id) DO UPDATE
			SET
				symbol = EXCLUDED.symbol,
				name = EXCLUDED.name,
				volatility = EXCLUDED.volatility,
				sector = EXCLUDED.sector
		`;

		const initPrice = parseFloat((Math.random() * 100 + 20).toFixed(2)); // Initial price between Rs.20 and Rs.120
		let ohlc: Omit<StockOHLC, "id"> = {
			open_price: initPrice,
			high_price: initPrice,
			low_price: initPrice,
			close_price: initPrice,
			stock_id: i,
			timestamp: new Date().toISOString(),
		};
		// Generate initial OHLC data for the stock
		for (let j = 0; j < ohlcCount; j++) {
			ohlc = generateStockPrice(ohlc, volatility); // Generate one new OHLC entry based on the previous candle
			await sql`
				INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price, timestamp)
				VALUES (${i}, ${ohlc.open_price}, ${ohlc.high_price}, ${ohlc.low_price}, ${ohlc.close_price}, ${ohlc.timestamp})
			`;
			console.log(
				`Generated OHLC for stock ${symbol} at timestamp ${ohlc.timestamp}: Open: ${ohlc.open_price.toFixed(
					2,
				)}, High: ${ohlc.high_price.toFixed(2)}, Low: ${ohlc.low_price.toFixed(2)}, Close: ${ohlc.close_price.toFixed(2)}`,
			);
		}

		console.log(`Generated stock ${symbol} with ${ohlcCount} OHLC entries.`);
	}

	console.log("Stocks generated successfully.");
};

generateStocks()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Error generating stocks:", err);
		process.exit(1);
	});

