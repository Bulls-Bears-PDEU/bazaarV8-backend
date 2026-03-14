// import config from "./config/config.js";
import express, { type Request, type Response } from "express";
import sql from "./database/database.js";
import stockRouter from "./routes/stock.js";
import { clerkMiddleware } from "@clerk/express";
import userRouter from "./routes/user.js";
import { createNewUser } from "./controller/user.js";
import { verifyWebhook } from "@clerk/express/webhooks";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { sendEmail } from "./lib/email.js";

const app: express.Application = express();

app.use(
	cors({
		origin: "http://localhost:5173", // Update this to match your frontend URL
		credentials: true,
	}),
);

app.use(express.json());
app.use(clerkMiddleware());

app.get("/", async (_, res) => {
	const result = await sql`	SELECT version()`;
	const { version } = result[0];
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end(version);
});

app.post("/webhook", async (req, res) => {
	try {
		const event = await verifyWebhook(req);
		console.log("Received webhook event:", event);

		switch (event.type) {
			case "user.created":
				createNewUser(event.data.id);
				console.log("User created:", event);
				break;
			case "user.updated":
				console.log("User updated:", event);
				break;
			case "user.deleted":
				console.log("User deleted:", event);
				break;
			default:
				console.log("Unhandled event type:", event);
		}
		res.status(200).send("Webhook received");
	} catch (error) {
		console.error("Failed to verify webhook:", error);
		return res.status(400).send("Invalid webhook signature");
	}
});

app.use("/stocks", stockRouter);
app.use("/users", userRouter);
app.all("/api/auth/{*any}", toNodeHandler(auth));

app.post("/test-email", async (req, res) => {
	const { to, subject, text } = req.body;
	try {
		await sendEmail({ to, subject, text });
		res.status(200).json({ message: "Email sent successfully" });
	} catch (error) {
		console.error("Error sending email:", error);
		res.status(500).json({ error: "Failed to send email" });
	}
});
export default app;
