import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { createServer } from "node:http";
import { Server } from "socket.io";
import config from "./config/config.js";
import sql from "./database/database.js";
import newsRouter from "./routes/news.js";
import ipoRouter from "./routes/ipo.js";
import marketRouter from "./routes/market.js";
import stockRouter from "./routes/stock.js";
import userRouter from "./routes/user.js";
import leaderboardRouter from "./routes/leaderboard.js";
import { auth } from "./lib/auth.js";
import { stockSimulator } from "./stockEngine.js";
import { broadcastLeaderboard } from "./controller/leaderboard.js";
import { getMarketState } from "./controller/market.js";
import type { MarketState } from "./models/market.js";
import eventEmitter from "./eventEmitter.js";
import socketAuth, { type SocketData } from "./middleware/socketAuth.js";
import { emitMarketState, registerIo, ROOMS } from "./realtime/emitter.js";

const app: express.Application = express();

app.use(
	cors({
		origin: config.FRONTEND_ORIGINS,
		credentials: true,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
	}),
);
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

app.get("/", async (_, res) => {
	const result = await sql`	SELECT version()`;
	const { version } = result[0];
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end(version);
});

app.use("/stocks", stockRouter);
app.use("/news", newsRouter);
app.use("/ipos", ipoRouter);
app.use("/users", userRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/market", marketRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: {
		// Must list origins explicitly: browsers refuse "*" together with
		// credentials, and without credentials the session cookie never arrives.
		origin: config.FRONTEND_ORIGINS,
		methods: ["GET", "POST"],
		credentials: true,
	},
});

registerIo(io);
io.use(socketAuth);

io.on("connection", (socket) => {
	const { userId, role } = socket.data as SocketData;

	socket.join(ROOMS.user(userId));
	if (role === "pending") {
		socket.join(ROOMS.lobby);
	} else {
		socket.join(ROOMS.market);
		if (role === "admin") {
			socket.join(ROOMS.admins);
		}
	}

	// Send the current market state straight away so a client that connects
	// while the market is paused renders the right state without polling.
	getMarketState()
		.then((state) => socket.emit("marketStateUpdate", state))
		.catch((err) => {
			console.error("Error sending market state to client:", err);
		});
});

// Broadcast market pause/sentiment changes made by admins.
eventEmitter.on("marketStateChanged", (state: MarketState) => {
	emitMarketState(state);
});

/**
 * Started by server.ts once the schema is in place, so the engine can never
 * query a table that initDB has not created yet.
 */
export const startBackgroundJobs = () => {
	setInterval(() => {
		stockSimulator().catch((err) => {
			console.error("Error in stock simulator:", err);
		});
	}, 1000);

	setInterval(() => {
		broadcastLeaderboard().catch((err) => {
			console.error("Error broadcasting leaderboard:", err);
		});
	}, 2000);
};

export default httpServer;
