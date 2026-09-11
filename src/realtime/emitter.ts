import type { Server } from "socket.io";

/**
 * Holds the Socket.IO server so controllers and the engine can emit without
 * importing app.ts, which already imports them and would create a cycle.
 *
 * Rooms:
 *   user:<id>  every socket of one user, for per-user events
 *   market     approved players and admins: prices, leaderboard, market state
 *   lobby      pending users: market state only, so they can see the lobby
 *   admins     admins only
 */
export const ROOMS = {
	market: "market",
	lobby: "lobby",
	admins: "admins",
	user: (userId: string) => `user:${userId}`,
} as const;

const USER_ROOM_PREFIX = "user:";

let io: Server | null = null;

export const registerIo = (server: Server) => {
	io = server;
};

export const emitToUser = (userId: string, event: string, payload: unknown) => {
	io?.to(ROOMS.user(userId)).emit(event, payload);
};

export const emitToMarket = (event: string, payload: unknown) => {
	io?.to(ROOMS.market).emit(event, payload);
};

export const emitToAdmins = (event: string, payload: unknown) => {
	io?.to(ROOMS.admins).emit(event, payload);
};

// Market state reaches the lobby too, so a pending or paused player's screen
// flips the moment an admin resumes.
export const emitMarketState = (payload: unknown) => {
	io?.to([ROOMS.market, ROOMS.lobby]).emit("marketStateUpdate", payload);
};

/** Ids of every user with at least one connected socket. */
export const onlineUserIds = (): string[] => {
	if (!io) return [];
	const ids: string[] = [];
	for (const room of io.sockets.adapter.rooms.keys()) {
		if (room.startsWith(USER_ROOM_PREFIX)) {
			ids.push(room.slice(USER_ROOM_PREFIX.length));
		}
	}
	return ids;
};
