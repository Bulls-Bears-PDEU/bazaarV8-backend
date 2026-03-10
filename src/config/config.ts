import dotenv from "dotenv";

dotenv.config();

type Config = {
	PORT: number;
	DATABASE_URL: string;
};

const config: Config = {
	PORT: parseInt(process.env.PORT || "3000", 10),
	DATABASE_URL: process.env.DATABASE_URL || "",
};

export default config;
