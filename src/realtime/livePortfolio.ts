/**
 * Pushes every online player their portfolio, valued at the engine's live
 * prices, once per tick ("portfolioTick"). The player app shows these figures
 * as they are instead of revaluing positions in the browser.
 *
 * Positions and balances only change when the player's own account does, so
 * they are cached per player and valued against fresh prices on every tick.
 * A player's cache is reloaded after any event sent to that player (a fill, a
 * cancel, an IPO allotment...) and, as a safety net for changes made elsewhere
 * such as an admin editing cash, whenever it is older than CACHE_TTL_MS.
 */

import { type PortfolioInputs, loadPortfolioInputs, valuePortfolio } from "../controller/portfolio.js";
import eventEmitter from "../eventEmitter.js";
import { emitToUser, marketUserIds } from "./emitter.js";

const CACHE_TTL_MS = 5_000;

const cache = new Map<string, { inputs: PortfolioInputs; loadedAt: number }>();
const stale = new Set<string>();

// Anything sent to a player may have changed their account.
eventEmitter.on("userEvent", (userId: string) => {
	stale.add(userId);
});

let isPublishing = false;

export const publishLivePortfolios = async () => {
	if (isPublishing) return;
	isPublishing = true;
	try {
		const online = marketUserIds();
		const onlineSet = new Set(online);
		for (const userId of cache.keys()) {
			if (!onlineSet.has(userId)) cache.delete(userId);
		}

		const now = Date.now();
		const toLoad = online.filter((userId) => {
			const entry = cache.get(userId);
			return !entry || stale.has(userId) || now - entry.loadedAt > CACHE_TTL_MS;
		});
		if (toLoad.length) {
			for (const userId of toLoad) stale.delete(userId);
			const loaded = await loadPortfolioInputs(toLoad);
			for (const [userId, inputs] of loaded) {
				cache.set(userId, { inputs, loadedAt: now });
			}
		}

		for (const userId of online) {
			const entry = cache.get(userId);
			if (!entry) continue;
			emitToUser(userId, "portfolioTick", valuePortfolio(entry.inputs));
		}
	} finally {
		isPublishing = false;
	}
};
