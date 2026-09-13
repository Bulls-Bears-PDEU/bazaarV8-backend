import sql from "../database/database.js";

const [email, role] = process.argv.slice(2);
const allowedRoles = new Set(["admin", "user", "pending"]);

if (!email || !role || !allowedRoles.has(role)) {
  console.error("Usage: pnpm set-role <email> <admin|user|pending>");
  process.exit(1);
}

const users = await sql`
	SELECT id, email, role
	FROM users
	WHERE LOWER(email) = LOWER(${email})
	LIMIT 1
`;

if (users.length === 0) {
  console.error(`No user found for ${email}`);
  process.exit(1);
}

await sql`
	UPDATE users
	SET role = ${role}
	WHERE id = ${users[0].id}
`;

console.log(`Updated ${users[0].email}: ${users[0].role} -> ${role}`);
