/**
 * A short-lived answer shared by every caller, for reads that are the same for
 * every player (the market overview, the news list...). With hundreds of
 * players polling, each such read reaches the database about once per ttl
 * instead of once per player.
 *
 * Callers that arrive while a load is in flight wait for that load rather than
 * starting their own. clear() drops everything at once, for the moment the
 * underlying data changes; a load that was already running when it was called
 * still answers its callers, but its result is not kept.
 *
 * Values are shared between callers, so they must not be mutated.
 */

// Keys come from query strings, so a client could make up any number of them.
const MAX_KEYS = 50;

type Entry<T> = { value: T; expiresAt: number };

export const sharedCache = <K, T>(
	ttlMs: number,
	load: (key: K) => Promise<T>,
) => {
	const entries = new Map<string, Entry<T>>();
	const inFlight = new Map<string, Promise<T>>();
	let generation = 0;

	const get = (key: K): Promise<T> => {
		const id = JSON.stringify(key ?? null);
		const entry = entries.get(id);
		if (entry && entry.expiresAt > Date.now())
			return Promise.resolve(entry.value);

		const running = inFlight.get(id);
		if (running) return running;

		const startedIn = generation;
		const pending = load(key)
			.then((value) => {
				if (startedIn === generation) {
					if (entries.size >= MAX_KEYS && !entries.has(id)) entries.clear();
					entries.set(id, { value, expiresAt: Date.now() + ttlMs });
				}
				return value;
			})
			.finally(() => {
				if (inFlight.get(id) === pending) inFlight.delete(id);
			});
		inFlight.set(id, pending);
		return pending;
	};

	const clear = () => {
		generation++;
		entries.clear();
		inFlight.clear();
	};

	return { get, clear };
};
