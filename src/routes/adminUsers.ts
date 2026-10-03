import { fromNodeHeaders } from "better-auth/node";
import { type Request, type Response, Router } from "express";
import {
	getUserDetail,
	getUserStats,
	listUsers,
	parseListUsersQuery,
	updateUserAsAdmin,
} from "../controller/adminUsers.js";
import { recordAdminAction } from "../controller/godMode.js";
import { auth } from "../lib/auth.js";
import { getSessionUser } from "../lib/session.js";
import requireAdmin from "../middleware/requireAdmin.js";
import { emitToAdmins } from "../realtime/emitter.js";
import { sendTradingError, TradingError } from "../trading/errors.js";

/**
 * User management for the admin panel. Role changes, bans and removals go
 * through Better Auth's admin API with the admin's own session, so its rules
 * apply (no banning or removing yourself) and a banned user's sessions are
 * revoked on the spot.
 */
const adminUsersRouter = Router();

adminUsersRouter.use(requireAdmin);

type BulkAction =
	| "approve"
	| "reject"
	| "ban"
	| "unban"
	| "make_admin"
	| "make_player";
const BULK_ACTIONS: BulkAction[] = [
	"approve",
	"reject",
	"ban",
	"unban",
	"make_admin",
	"make_player",
];
const MAX_BULK = 200;
/** How each action reads in the trail. */
const ACTION_SUMMARY: Record<BulkAction, string> = {
	approve: "Approved the account",
	reject: "Removed the account",
	ban: "Banned the account",
	unban: "Lifted the ban",
	make_admin: "Made an admin",
	make_player: "Made a player",
};
// Longest timed ban the panel offers; longer means permanent.
const MAX_BAN_SECONDS = 365 * 24 * 60 * 60;

const idParam = (req: Request) => String(req.params.id ?? "");

// ?search=&status=all|pending|active|banned|online&role=all|user|admin|pending
// &sort=joined|name|cash|net_worth&direction=asc|desc&page=&page_size=
adminUsersRouter.get("/", async (req, res) => {
	try {
		res.json(
			await listUsers(
				parseListUsersQuery(req.query as Record<string, unknown>),
			),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

adminUsersRouter.get("/stats", async (_req, res) => {
	try {
		res.json(await getUserStats());
	} catch (error) {
		sendTradingError(res, error);
	}
});

adminUsersRouter.get("/:id", async (req, res) => {
	try {
		res.json(await getUserDetail(idParam(req)));
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { name?, remove_avatar?, cash_balance?, hidden_from_leaderboard? }.
adminUsersRouter.patch("/:id", async (req, res) => {
	try {
		await updateUserAsAdmin(idParam(req), req.body);
		const self = getSessionUser(res);
		const changed = Object.keys(
			(req.body ?? {}) as Record<string, unknown>,
		).join(", ");
		await recordAdminAction(
			{ id: self.id, name: self.name ?? "Admin" },
			"user_edited",
			idParam(req),
			`Edited ${changed || "account"}`,
			(req.body ?? {}) as Record<string, unknown>,
		);
		res.json(await getUserDetail(idParam(req)));
	} catch (error) {
		sendTradingError(res, error);
	}
});

const errorMessage = (error: unknown) =>
	(error as { body?: { message?: string } })?.body?.message ??
	(error instanceof Error ? error.message : "Something went wrong.");

/** Runs one action for one user through Better Auth, as the signed-in admin. */
const runAction = async (
	req: Request,
	res: Response,
	action: BulkAction,
	userId: string,
	ban: { reason?: string; seconds?: number },
) => {
	const headers = fromNodeHeaders(req.headers);
	const self = getSessionUser(res).id;
	if (userId === self && action !== "unban") {
		throw new Error("You cannot change your own account from here.");
	}
	switch (action) {
		case "approve":
		case "make_player":
			await auth.api.setRole({ body: { userId, role: "user" }, headers });
			return;
		case "make_admin":
			await auth.api.setRole({ body: { userId, role: "admin" }, headers });
			return;
		case "reject":
			await auth.api.removeUser({ body: { userId }, headers });
			return;
		case "ban":
			await auth.api.banUser({
				body: { userId, banReason: ban.reason, banExpiresIn: ban.seconds },
				headers,
			});
			return;
		case "unban":
			await auth.api.unbanUser({ body: { userId }, headers });
			return;
	}
};

// Body: { action, user_ids: string[], reason?, duration_seconds? }. Each user is
// handled on its own, so one failure does not undo the rest; the response says
// which ones failed and why.
adminUsersRouter.post("/bulk", async (req, res) => {
	try {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const action = body.action as BulkAction;
		if (!BULK_ACTIONS.includes(action)) {
			throw new TradingError("INVALID_INPUT", "Unknown action.");
		}
		const ids = Array.isArray(body.user_ids)
			? [
					...new Set(
						body.user_ids.filter(
							(id): id is string => typeof id === "string" && id.length > 0,
						),
					),
				]
			: [];
		if (ids.length === 0 || ids.length > MAX_BULK) {
			throw new TradingError(
				"INVALID_INPUT",
				`Choose between 1 and ${MAX_BULK} users.`,
			);
		}

		const reason =
			typeof body.reason === "string"
				? body.reason.trim().slice(0, 200) || undefined
				: undefined;
		let seconds: number | undefined;
		if (body.duration_seconds !== undefined && body.duration_seconds !== null) {
			seconds = Number(body.duration_seconds);
			if (
				!Number.isInteger(seconds) ||
				seconds <= 0 ||
				seconds > MAX_BAN_SECONDS
			) {
				throw new TradingError(
					"INVALID_INPUT",
					"Ban length must be between a second and a year, or permanent.",
				);
			}
		}

		const self = getSessionUser(res);
		const admin = { id: self.id, name: self.name ?? "Admin" };
		const failed: { id: string; error: string }[] = [];
		for (const id of ids) {
			try {
				await runAction(req, res, action, id, { reason, seconds });
				await recordAdminAction(admin, action, id, ACTION_SUMMARY[action], {
					reason: reason ?? null,
					duration_seconds: seconds ?? null,
				});
			} catch (error) {
				failed.push({ id, error: errorMessage(error) });
			}
		}
		emitToAdmins("usersChanged", {});
		res.json({ succeeded: ids.length - failed.length, failed });
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default adminUsersRouter;
