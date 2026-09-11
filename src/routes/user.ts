import { Router } from "express";
import { approveUser } from "../controller/user.js";
import requireAdmin from "../middleware/requireAdmin.js";

// Users are created by Better Auth's sign-up flow. The old POST /users/create
// was an unauthenticated Clerk-webhook leftover that could not work anyway:
// Better Auth's users table requires email, name and timestamps.
const userRouter = Router();

userRouter.put("/approve/:id", requireAdmin, async (req, res) => {
	const userId = Array.isArray(req.params.id)
		? req.params.id[0]
		: req.params.id;

	if (!userId) {
		return res.status(400).json({ error: "User id is required" });
	}

	try {
		await approveUser(userId);
		res.json({ message: "User approved successfully" });
	} catch (error) {
		res.status(500).json({ error: "Failed to approve user" });
	}
});

export default userRouter;
