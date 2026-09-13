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
import orderRouter from "./routes/orders.js";
import portfolioRouter from "./routes/portfolio.js";
import { auth } from "./lib/auth.js";
import { stockSimulator, TICK_INTERVAL_MS } from "./stockEngine.js";
import { broadcastLeaderboard } from "./controller/leaderboard.js";
import { getMarketState } from "./controller/market.js";
import type { MarketState } from "./models/market.js";
import eventEmitter from "./eventEmitter.js";
import socketAuth, { type SocketData } from "./middleware/socketAuth.js";
import { emitMarketState, registerIo, ROOMS } from "./realtime/emitter.js";
import { drainQueuedFills, loadRestingOrders } from "./trading/matcher.js";
import { drainTriggeredAlerts, loadActiveAlerts } from "./trading/alerts.js";
import watchlistRouter from "./routes/watchlist.js";
import { capturePortfolioSnapshots } from "./controller/analytics.js";
import alertRouter from "./routes/alerts.js";

const app: express.Application = express();

app.use(
	cors({
		origin: config.FRONTEND_ORIGINS,
		credentials: true,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
	}),
);
// Logs any request slower than 2s, and any the client gave up on before an
// answer was sent. Every request crosses the Atlantic to Neon at least once,
// so a stall here is the first place to look when a screen hangs.
const SLOW_REQUEST_MS = 2000;
app.use((req, res, next) => {
	const started = Date.now();
	res.on("finish", () => {
		const ms = Date.now() - started;
		if (ms > SLOW_REQUEST_MS) console.warn(`Slow request: ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
	});
	res.on("close", () => {
		if (!res.writableFinished) {
			console.warn(`Request abandoned: ${req.method} ${req.originalUrl} after ${Date.now() - started}ms`);
		}
	});
	next();
});

app.use("/api/auth", (req, _res, next) => {
	const forwardedProto = req.headers["x-forwarded-proto"];
	const firstForwardedProto = Array.isArray(forwardedProto)
		? forwardedProto[0]
		: forwardedProto;
	if (firstForwardedProto) {
		req.headers["x-forwarded-proto"] = firstForwardedProto
			.split(",")[0]
			.trim();
	}
	next();
});

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
app.use("/orders", orderRouter);
app.use("/portfolio", portfolioRouter);
app.use("/watchlists", watchlistRouter);
app.use("/alerts", alertRouter);

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
export const startBackgroundJobs = async () => {
  await Promise.all([loadRestingOrders(), loadActiveAlerts()]);

  setInterval(() => {
    stockSimulator().catch((err) => {
      console.error("Error in stock simulator:", err);
    });
  }, TICK_INTERVAL_MS);

  // Settles limit orders and fires alerts the tick found crossing. Separate
  // from the tick so a burst of fills can never delay prices.
  setInterval(() => {
    drainQueuedFills().catch((err) => {
      console.error("Error filling limit orders:", err);
    });
    drainTriggeredAlerts().catch((err) => {
      console.error("Error firing price alerts:", err);
    });
  }, 250);

  setInterval(() => {
    broadcastLeaderboard().catch((err) => {
      console.error("Error broadcasting leaderboard:", err);
    });
  }, 2000);

  // Equity-curve points for players who are online.
  setInterval(() => {
    capturePortfolioSnapshots().catch((err) => {
      console.error("Error capturing portfolio snapshots:", err);
    });
  }, 30_000);
};;;

export default httpServer;
