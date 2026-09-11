import { fromNodeHeaders } from "better-auth/node";
import type { ExtendedError, Socket } from "socket.io";
import { auth } from "../lib/auth.js";
import { isBanned } from "../lib/session.js";

export type SocketData = {
	userId: string;
	role: string;
};

/**
 * Resolves the Better Auth session from the handshake cookie, the same way the
 * HTTP middleware does, and refuses the connection without one. Before this,
 * any client could connect and receive every price tick and the full
 * leaderboard.
 *
 * The cookie only arrives if the client connects with withCredentials: true and
 * the server's CORS config names the origin (browsers refuse "*" with
 * credentials). Both fail silently, so check them first when debugging.
 */
const socketAuth = async (
	socket: Socket,
	next: (err?: ExtendedError) => void,
) => {
	try {
		const session = await auth.api.getSession({
			headers: fromNodeHeaders(socket.request.headers),
		});

		if (!session || isBanned(session.user)) {
			return next(new Error("UNAUTHORIZED"));
		}

		const data: SocketData = {
			userId: session.user.id,
			role: session.user.role ?? "pending",
		};
		socket.data = data;
		next();
	} catch (error) {
		console.error("Socket authentication failed:", error);
		next(new Error("UNAUTHORIZED"));
	}
};

export default socketAuth;
