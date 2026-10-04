/**
 * The reads every player polls for and gets the same answer to, served from
 * one shared copy. Price driven figures keep theirs a few seconds; lists that
 * only change when an organiser changes them keep theirs longer and are
 * dropped the moment the change is broadcast.
 */

import { getActiveAds } from "../controller/ads.js";
import { getAllIpos } from "../controller/ipo.js";
import {
	getIndexHistory,
	getMarketOverview,
} from "../controller/marketOverview.js";
import { getAllNews } from "../controller/news.js";
import { getAllStocks } from "../controller/stock.js";
import eventEmitter from "../eventEmitter.js";
import { sharedCache } from "./sharedCache.js";

const PRICE_TTL_MS = 5_000;
const LIST_TTL_MS = 15_000;

export const marketOverviewCache = sharedCache(
	PRICE_TTL_MS,
	(candles: number | undefined) => getMarketOverview(candles),
);

export const indexHistoryCache = sharedCache(
	PRICE_TTL_MS,
	({
		points,
		basis,
	}: {
		points: number | undefined;
		basis: "start" | "window";
	}) => getIndexHistory(points, basis),
);

export const newsCache = sharedCache(LIST_TTL_MS, () => getAllNews());

export const iposCache = sharedCache(
	LIST_TTL_MS,
	(filters: Parameters<typeof getAllIpos>[0]) => getAllIpos(filters),
);

export const stocksCache = sharedCache(LIST_TTL_MS, () => getAllStocks());

export const adsCache = sharedCache(LIST_TTL_MS, () => getActiveAds());

// The overview also carries the market state, the latest news and the IPOs.
eventEmitter.on("marketStateChanged", () => marketOverviewCache.clear());

eventEmitter.on("marketBroadcast", (event: string) => {
	switch (event) {
		case "newsReleased":
		case "newsChanged":
			newsCache.clear();
			marketOverviewCache.clear();
			break;
		case "iposChanged":
			iposCache.clear();
			marketOverviewCache.clear();
			break;
		case "stocksChanged":
			stocksCache.clear();
			marketOverviewCache.clear();
			break;
		case "adsChanged":
			adsCache.clear();
			break;
	}
});
