import dotenv from "dotenv";

dotenv.config();

type Config = {
	PORT: number;
	DATABASE_URL: string;
	// Optional direct (non "-pooler") Neon endpoint for the pg pool that runs
	// trading writes. Falls back to DATABASE_URL.
	TRADING_DATABASE_URL: string;
	ENABLE_STOCK_DB_UPDATES: boolean;
	// Public URL of this server, used by Better Auth as its baseURL.
	BACKEND_URL: string;
	ADMIN_APP_URL: string;
	PLAYER_APP_URL: string;
	// Every browser origin allowed to call the API and open a socket with
	// cookies. Defaults to the admin panel and the player app.
	FRONTEND_ORIGINS: string[];
};

const parseBooleanEnv = (value: string | undefined, defaultValue: boolean) => {
	if (value === undefined) {
		return defaultValue;
	}

	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}

	return defaultValue;
};

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_APP_URL = trimTrailingSlash(
	process.env.ADMIN_APP_URL || "http://localhost:5173",
);
const PLAYER_APP_URL = trimTrailingSlash(
	process.env.PLAYER_APP_URL || "http://localhost:5174",
);

const config: Config = {
	PORT,
	DATABASE_URL,
	TRADING_DATABASE_URL: process.env.TRADING_DATABASE_URL || DATABASE_URL,
	ENABLE_STOCK_DB_UPDATES: parseBooleanEnv(
		process.env.ENABLE_STOCK_DB_UPDATES,
		true,
	),
	BACKEND_URL: trimTrailingSlash(
		process.env.BACKEND_URL || `http://localhost:${PORT}`,
	),
	ADMIN_APP_URL,
	PLAYER_APP_URL,
	FRONTEND_ORIGINS: process.env.FRONTEND_ORIGINS
		? process.env.FRONTEND_ORIGINS.split(",")
				.map((origin) => trimTrailingSlash(origin.trim()))
				.filter(Boolean)
		: [ADMIN_APP_URL, PLAYER_APP_URL],
};

if (!config.DATABASE_URL) {
	throw new Error("DATABASE_URL is not set");
}

export default config;
