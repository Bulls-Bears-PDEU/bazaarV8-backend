import sql from "../database/database.js";
import { initDB } from "../database/schema.js";
import { persistCandles, simulateHistory } from "../stockEngine.js";

/**
 * Seeds the market with NSE large caps under their real symbols, names and
 * sectors, and gives each one a stretch of recent price history.
 *
 *   price       approximate NSE price in rupees (late 2025), rounded: a
 *               realistic starting point, not a live quote.
 *   volatility  annualised volatility, roughly each stock's one-year
 *               historical figure. It stays in real-world units; the engine
 *               scales it to the length of a game.
 *
 * Sectors are shared on purpose: the engine moves stocks in one sector
 * together, so the banks, the IT names and the metals trend as groups.
 *
 * Usage: pnpm seed:stocks [count] [candles]
 *   count    seed only the first `count` stocks (default: all of them)
 *   candles  10 second candles of history per stock (default: 90, 15 minutes)
 *
 * Re-running it resets every seeded stock to its starting price and replaces
 * its price history. Stocks are matched by symbol, so their ids, and with them
 * holdings and orders, are kept. Run it while the backend is stopped: a running
 * engine keeps prices in memory and would carry on from its own.
 */
type SeedStock = {
	symbol: string;
	name: string;
	sector: string;
	volatility: number;
	price: number;
};

// biome-ignore format: one stock per line reads as a table
const seedStocks: SeedStock[] = [
	{ symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy", volatility: 0.22, price: 1_500 },
	{ symbol: "ONGC", name: "Oil & Natural Gas Corporation", sector: "Energy", volatility: 0.26, price: 250 },

	{ symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", volatility: 0.18, price: 990 },
	{ symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", volatility: 0.19, price: 1_380 },
	{ symbol: "SBIN", name: "State Bank of India", sector: "Banking", volatility: 0.23, price: 950 },
	{ symbol: "AXISBANK", name: "Axis Bank", sector: "Banking", volatility: 0.24, price: 1_230 },
	{ symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Financial Services", volatility: 0.3, price: 1_020 },

	{ symbol: "TCS", name: "Tata Consultancy Services", sector: "IT", volatility: 0.21, price: 3_100 },
	{ symbol: "INFY", name: "Infosys", sector: "IT", volatility: 0.25, price: 1_520 },
	{ symbol: "HCLTECH", name: "HCL Technologies", sector: "IT", volatility: 0.24, price: 1_600 },
	{ symbol: "WIPRO", name: "Wipro", sector: "IT", volatility: 0.27, price: 245 },

	{ symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", volatility: 0.2, price: 2_080 },

	{ symbol: "ITC", name: "ITC", sector: "FMCG", volatility: 0.18, price: 405 },
	{ symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG", volatility: 0.2, price: 2_450 },

	{ symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure", volatility: 0.23, price: 3_950 },
	{ symbol: "ADANIENT", name: "Adani Enterprises", sector: "Infrastructure", volatility: 0.42, price: 2_400 },

	{ symbol: "MARUTI", name: "Maruti Suzuki India", sector: "Automobile", volatility: 0.23, price: 15_800 },
	{ symbol: "M&M", name: "Mahindra & Mahindra", sector: "Automobile", volatility: 0.28, price: 3_650 },

	{ symbol: "SUNPHARMA", name: "Sun Pharmaceutical Industries", sector: "Pharma", volatility: 0.21, price: 1_750 },
	{ symbol: "CIPLA", name: "Cipla", sector: "Pharma", volatility: 0.22, price: 1_520 },

	{ symbol: "TITAN", name: "Titan Company", sector: "Consumer", volatility: 0.25, price: 3_800 },
	{ symbol: "ASIANPAINT", name: "Asian Paints", sector: "Consumer", volatility: 0.24, price: 2_750 },
	{ symbol: "ETERNAL", name: "Eternal (Zomato)", sector: "Consumer", volatility: 0.45, price: 310 },

	{ symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals", volatility: 0.31, price: 170 },
	{ symbol: "HINDALCO", name: "Hindalco Industries", sector: "Metals", volatility: 0.3, price: 800 },

	{ symbol: "NTPC", name: "NTPC", sector: "Power", volatility: 0.24, price: 330 },
	{ symbol: "POWERGRID", name: "Power Grid Corporation of India", sector: "Power", volatility: 0.23, price: 280 },
];

const DEFAULT_CANDLES = 90;
const MAX_CANDLES = 10_000;

const generateStocks = async () => {
	const [countArg, candlesArg] = process.argv.slice(2);
	const count = Number(countArg) || seedStocks.length;
	const candles = Number(candlesArg) || DEFAULT_CANDLES;
	if (!Number.isInteger(count) || count < 1 || count > seedStocks.length) {
		throw new Error(`count must be between 1 and ${seedStocks.length}`);
	}
	if (!Number.isInteger(candles) || candles < 1 || candles > MAX_CANDLES) {
		throw new Error(`candles must be between 1 and ${MAX_CANDLES}`);
	}

	// The schema is no longer created as a side effect of importing the database.
	await initDB();

	const stocks = seedStocks.slice(0, count);
	console.log(
		`Seeding ${stocks.length} stocks with ${candles} candles of history each...`,
	);

	// Every stock's history ends at the same moment, just before now.
	const endAt = new Date();

	for (const { symbol, name, sector, volatility, price } of stocks) {
		const [row] = await sql`
			INSERT INTO stocks (symbol, name, volatility, sector, last_price, last_price_at)
			VALUES (${symbol}, ${name}, ${volatility}, ${sector}, ${price}, CURRENT_TIMESTAMP)
			ON CONFLICT (symbol) DO UPDATE
			SET
				name = EXCLUDED.name,
				volatility = EXCLUDED.volatility,
				sector = EXCLUDED.sector,
				last_price = EXCLUDED.last_price,
				last_price_at = EXCLUDED.last_price_at,
				starting_price = EXCLUDED.last_price
			RETURNING id
		`;
		const stockId = Number(row.id);

		await sql`DELETE FROM stock_ohlc WHERE stock_id = ${stockId}`;
		await persistCandles(
			simulateHistory({ stockId, endPrice: price, volatility, candles, endAt }),
		);

		console.log(
			`Seeded ${symbol.padEnd(10)} Rs.${price.toFixed(2).padStart(9)}  vol ${volatility.toFixed(2)}  ${sector}`,
		);
	}

	const others = await sql`
		SELECT symbol FROM stocks
		WHERE NOT (symbol = ANY(${stocks.map((stock) => stock.symbol)}::text[]))
		ORDER BY symbol
	`;
	if (others.length > 0) {
		console.log(
			`Left as they were (not in the seed list): ${others.map((other) => other.symbol).join(", ")}`,
		);
	}

	console.log(
		"Stocks seeded. Start or restart the backend so the engine trades from these prices.",
	);
};

generateStocks()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Error generating stocks:", err);
		process.exit(1);
	});
