import { Router } from "express";
import { approveUser, createNewUser } from "../controller/user.js";
import requireAdmin from "../middleware/requireAdmin.js";

const userRouter = Router();

userRouter.post("/create", async (req, res) => {
	// Placeholder for user creation logic
	try {
		await createNewUser(req.body.id);
		res.json({ message: "User created successfully" });
	} catch (error) {
		res.status(500).json({ error });
	}
});

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
