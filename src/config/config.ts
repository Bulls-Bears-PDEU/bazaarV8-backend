import dotenv from "dotenv";

dotenv.config();

type Config = {
	PORT: number;
	DATABASE_URL: string;
	ENABLE_STOCK_DB_UPDATES: boolean;
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

const config: Config = {
	PORT: parseInt(process.env.PORT || "3000", 10),
	DATABASE_URL: process.env.DATABASE_URL || "",
	ENABLE_STOCK_DB_UPDATES: parseBooleanEnv(
		process.env.ENABLE_STOCK_DB_UPDATES,
		true,
	),
};

export default config;
