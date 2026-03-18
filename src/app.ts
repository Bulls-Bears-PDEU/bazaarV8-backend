// import config from "./config/config.js";
import express, { type Request, type Response } from "express";
import sql from "./database/database.js";
import stockRouter from "./routes/stock.js";
import userRouter from "./routes/user.js";
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

app.get("/", async (_, res) => {
	const result = await sql`	SELECT version()`;
	const { version } = result[0];
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end(version);
});

app.use("/stocks", stockRouter);
app.use("/users", userRouter);
app.all("/api/auth/{*any}", toNodeHandler(auth));

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
export default app;
