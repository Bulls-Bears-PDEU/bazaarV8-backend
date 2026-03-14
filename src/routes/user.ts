import { Router } from "express";
import { createNewUser } from "../controller/user.js";

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

export default userRouter;
