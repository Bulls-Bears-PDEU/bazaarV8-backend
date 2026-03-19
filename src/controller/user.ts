import sql from "../database/database.js";

export const createNewUser = async (id: string) => {
	const defaultBalance = 5_00_000;
	await sql`INSERT INTO users (id, cash_balance) VALUES (${id}, ${defaultBalance})`;
};

export const approveUser = async (id: string) => {
	await sql`
		UPDATE users
		SET role = 'user'
		WHERE id = ${id}
	`;
};
