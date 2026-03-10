import sql from "../database/database.js";

type Ohlc = {
	open: number;
	high: number;
	low: number;
	close: number;
};

const WORD_PREFIXES = [
	"Global",
	"Prime",
	"Blue",
	"United",
	"Apex",
	"Silver",
	"Vertex",
	"Quantum",
	"Nova",
	"Pioneer",
	"Summit",
	"Orbit",
];

const WORD_SUFFIXES = [
	"Tech",
	"Energy",
	"Foods",
	"Industries",
	"Motors",
	"Retail",
	"Labs",
	"Finance",
	"Health",
	"Logistics",
	"Systems",
	"Pharma",
];

const SECTORS = [
	"Technology",
	"Financial Services",
	"Healthcare",
	"Energy",
	"Consumer Defensive",
	"Consumer Cyclical",
	"Industrials",
	"Utilities",
	"Basic Materials",
	"Real Estate",
	"Communication Services",
];

const parseArgs = () => {
	const args = process.argv.slice(2);
	let count = 50;
	let truncate = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		if (arg === "--truncate") {
			truncate = true;
			continue;
		}

		if ((arg === "--count" || arg === "-c") && args[index + 1]) {
			count = Number.parseInt(args[index + 1], 10);
			index += 1;
			continue;
		}

		if (arg.startsWith("--count=")) {
			count = Number.parseInt(arg.split("=")[1], 10);
		}
	}

	if (!Number.isFinite(count) || count <= 0) {
		throw new Error("Invalid count value. Use a positive integer.");
	}

	return { count, truncate };
};

const randomInteger = (min: number, max: number) => {
	const low = Math.ceil(min);
	const high = Math.floor(max);
	return Math.floor(Math.random() * (high - low + 1)) + low;
};

const randomNumber = (min: number, max: number, digits = 2) => {
	const value = Math.random() * (max - min) + min;
	return Number.parseFloat(value.toFixed(digits));
};

const makeCompanyName = () => {
	const prefix = WORD_PREFIXES[randomInteger(0, WORD_PREFIXES.length - 1)];
	const suffix = WORD_SUFFIXES[randomInteger(0, WORD_SUFFIXES.length - 1)];
	return `${prefix} ${suffix}`;
};

const makeSector = () => SECTORS[randomInteger(0, SECTORS.length - 1)];

const makeSymbol = (usedSymbols: Set<string>, name: string) => {
	const words = name.split(" ");
	let base = words.map((word) => word[0]).join("");

	if (base.length < 3) {
		base = `${base}${words[words.length - 1].slice(0, 3)}`;
	}

	base = base
		.toUpperCase()
		.replace(/[^A-Z]/g, "")
		.slice(0, 4);

	let symbol = base;
	while (usedSymbols.has(symbol) || symbol.length < 2) {
		symbol = `${base}${randomInteger(0, 99)}`.slice(0, 6);
	}

	usedSymbols.add(symbol);
	return symbol;
};

const makeOhlc = (price: number): Ohlc => {
	const open = randomNumber(price * 0.95, price * 1.05);
	const close = randomNumber(price * 0.95, price * 1.05);
	const high = randomNumber(
		Math.max(open, close),
		Math.max(open, close) * 1.06,
	);
	const low = randomNumber(Math.min(open, close) * 0.94, Math.min(open, close));

	return {
		open,
		high,
		low,
		close,
	};
};

const seedStocks = async () => {
	const { count, truncate } = parseArgs();

	await sql`
    CREATE TABLE IF NOT EXISTS stocks (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(10) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      price NUMERIC(10, 2) NOT NULL,
      ohlc JSONB NOT NULL CHECK (jsonb_typeof(ohlc) = 'array'),
      volume BIGINT NOT NULL,
      drift NUMERIC(5, 2) NOT NULL,
      volatility NUMERIC(5, 2) NOT NULL,
			sector VARCHAR(100) NOT NULL,
			locked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;

	if (truncate) {
		await sql`TRUNCATE TABLE stocks RESTART IDENTITY`;
	}

	const usedSymbols = new Set<string>();
	for (let index = 0; index < count; index += 1) {
		const name = makeCompanyName();
		const symbol = makeSymbol(usedSymbols, name);
		const price = randomNumber(10, 1500);
		const ohlc = [makeOhlc(price)];
		const ohlcJson = JSON.stringify(ohlc);
		const volume = randomInteger(50_000, 10_000_000);
		const drift = randomNumber(-5, 5);
		const volatility = randomNumber(0.5, 10);
		const sector = makeSector();

		await sql`
      INSERT INTO stocks (symbol, name, price, ohlc, volume, drift, volatility, sector)
      VALUES (${symbol}, ${name}, ${price}, ${ohlcJson}::jsonb, ${volume}, ${drift}, ${volatility}, ${sector})`;
	}

	console.info(`Inserted ${count} random stocks into stocks table.`);
};

seedStocks()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error("Failed to seed stocks:", error);
		process.exit(1);
	});
