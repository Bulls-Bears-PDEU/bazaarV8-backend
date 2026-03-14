import sql from "../database/database.js";

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
	const ohlcCount = Number(process.argv.slice(2)[1]) || 30;

	console.log(
		`Generating ${count} stocks with ${ohlcCount} OHLC entries each...`,
	);

	for (let i = 1; i <= count; i++) {
		const symbol = `STK${i}`;
		const name = `Stock ${i}`;
		const volatility = parseFloat((Math.random() * 5 + 1).toFixed(2)); // Random volatility between 1% and 6%
		const sector = sectors[Math.floor(Math.random() * sectors.length)];

		await sql`
			INSERT INTO STOCKS (symbol, name, volatility, sector)
			VALUES (${symbol}, ${name}, ${volatility}, ${sector})
		`;

		// Generate initial OHLC data for the stock
		for (let j = 0; j < ohlcCount; j++) {
			const openPrice = parseFloat((Math.random() * 100 + 20).toFixed(2));
			const highPrice = parseFloat(
				(openPrice * (1 + Math.random() * 0.1)).toFixed(2),
			); // Up to 10% higher than open
			const lowPrice = parseFloat(
				(openPrice * (1 - Math.random() * 0.1)).toFixed(2),
			); // Up to 10% lower than open
			const closePrice = parseFloat(
				(lowPrice + Math.random() * (highPrice - lowPrice)).toFixed(2),
			); // Between low and high
			await sql`
			INSERT INTO stock_ohlc (stock_id, open_price, high_price, low_price, close_price)
			VALUES (${i}, ${openPrice}, ${highPrice}, ${lowPrice}, ${closePrice})
		`;
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

