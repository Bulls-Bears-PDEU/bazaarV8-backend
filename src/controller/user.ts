import sql from "../database/database.js";

export const approveUser = async (id: string) => {
	await sql`
		UPDATE users
		SET role = 'user'
		WHERE id = ${id}
	`;
};
