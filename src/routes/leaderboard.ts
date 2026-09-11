import { Router } from "express";

import { getLeaderboard } from "../controller/leaderboard.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";

const leaderboardRouter = Router();

leaderboardRouter.use(requireApprovedUser);

leaderboardRouter.get("/", getLeaderboard);

export default leaderboardRouter;
