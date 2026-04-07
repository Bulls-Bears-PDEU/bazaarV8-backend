import { Router } from "express";

import { getLeaderboard } from "../controller/leaderboard.js";
const leaderboardRouter = Router();

leaderboardRouter.get("/", getLeaderboard);

export default leaderboardRouter;
