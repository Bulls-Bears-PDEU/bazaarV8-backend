import httpServer, { startBackgroundJobs } from "./app.js";
import config from "./config/config.js";
import { initDB } from "./database/schema.js";

const start = async () => {
	await initDB();
	console.info("Database schema is up to date.");

	startBackgroundJobs();

	httpServer.listen(config.PORT, () => {
		console.log(`Server is running on port ${config.PORT}`);
	});
};

start().catch((err) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
