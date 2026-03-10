import sql from "../database/database.js";

export const createNewUser = async (email: string, name: string) => {
	const id = crypto.randomUUID();
	const defaultBalance = 5_00_000;
	await sql`INSERT INTO users (id, email, name, balance) VALUES (${id}, ${email}, ${name}, ${defaultBalance})`;
};
