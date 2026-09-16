/**
 * Uploads stock logos from a folder, through the same compression a logo
 * uploaded from the admin panel gets.
 *
 *   pnpm set-logos [folder]      (default: assets/logos)
 *
 * Files are matched to stocks by name: RELIANCE.png sets RELIANCE's logo.
 * PNG, JPEG and WebP all work, at any size -- each is re-encoded to a 256px
 * WebP before it is stored. Stocks with no matching file are left alone.
 *
 * Run it while the backend is stopped or running; open browsers pick the new
 * logos up the next time they load the stock list.
 */

import fs from "node:fs";
import path from "node:path";
import { LOGO_SIZE, setStockLogo } from "../controller/stockLogos.js";
import sql from "../database/database.js";

const folder = path.resolve(process.argv[2] ?? "assets/logos");
if (!fs.existsSync(folder)) {
	console.error(`No such folder: ${folder}`);
	process.exit(1);
}

const stocks = await sql`SELECT id, symbol FROM stocks ORDER BY symbol`;
const files = fs
	.readdirSync(folder)
	.filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
const bySymbol = new Map(
	files.map((name) => [path.parse(name).name.toUpperCase(), name]),
);

let stored = 0;
let before = 0;
let after = 0;
for (const stock of stocks) {
	const symbol = String(stock.symbol).toUpperCase();
	const file = bySymbol.get(symbol);
	if (!file) {
		console.log(`  -  ${symbol.padEnd(12)} no file`);
		continue;
	}
	const input = fs.readFileSync(path.join(folder, file));
	try {
		const { bytes } = await setStockLogo(Number(stock.id), input);
		before += input.length;
		after += bytes;
		stored += 1;
		console.log(
			`  ok ${symbol.padEnd(12)} ${file.padEnd(16)} ${String(input.length).padStart(7)} -> ${String(bytes).padStart(6)} bytes`,
		);
	} catch (error) {
		console.error(
			`  !! ${symbol.padEnd(12)} ${file}: ${error instanceof Error ? error.message : error}`,
		);
	}
	bySymbol.delete(symbol);
}

for (const [symbol, file] of bySymbol) {
	console.log(`  ?  ${file} matches no stock (looked for symbol ${symbol})`);
}

console.log(
	`\n${stored} logo(s) stored as ${LOGO_SIZE}px WebP: ${before.toLocaleString()} bytes uploaded, ${after.toLocaleString()} stored.`,
);
process.exit(0);
