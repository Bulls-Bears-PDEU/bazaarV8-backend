import { Router } from "express";

import { getLeaderboard, getMyRank } from "../controller/leaderboard.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";

const leaderboardRouter = Router();

leaderboardRouter.use(requireApprovedUser);

leaderboardRouter.get("/", getLeaderboard);
leaderboardRouter.get("/myRank", getMyRank);

export default leaderboardRouter;
