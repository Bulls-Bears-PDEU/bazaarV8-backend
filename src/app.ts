// import config from "./config/config.js";
import express, { type Request, type Response } from "express";
import sql from "./database/database.js";
import newsRouter from "./routes/news.js";
import ipoRouter from "./routes/ipo.js";
import stockRouter from "./routes/stock.js";
import userRouter from "./routes/user.js";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { sendEmail } from "./lib/email.js";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { stockSimulator } from "./stockEngine.js";

const app: express.Application = express();

app.use(
	cors({
		origin: "http://localhost:5173", // Update this to match your frontend URL
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

app.post("/test-email", async (req, res) => {
	const { to, subject, text } = req.body;
	try {
		await sendEmail({ to, subject, otp: text });
		res.status(200).json({ message: "Email sent successfully" });
	} catch (error) {
		console.error("Error sending email:", error);
		res.status(500).json({ error: "Failed to send email" });
	}
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: {
		origin: "*", // Update this to match frontend URL
		methods: ["GET", "POST"],
	},
});

io.on("connection", (socket) => {
	console.log("A client connected:", socket.id);
	socket.on("disconnect", () => {
		console.log("A client disconnected:", socket.id);
	});
});

// Run the stock simulator every 1 seconds.
setInterval(() => {
	stockSimulator(io).catch((err) => {
		console.error("Error in stock simulator:", err);
	});
}, 1000);

export default httpServer;
