import express from "express";
// import config from "./config/config.js";
import sql from "./database/database.js";
import stockRouter from "./routes/stock.js";
import { clerkMiddleware } from "@clerk/express";
import userRouter from "./routes/user.js";
import { createNewUser } from "./controller/user.js";
import { verifyWebhook } from "@clerk/express/webhooks";
import cors from "cors";

const app: express.Application = express();

app.use(cors());

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
				createNewUser(
					event.data.email_addresses[0].email_address,
					event.data.first_name ?? "User",
				);
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
export default app;
