import { Router } from "express";
import {
	cancelOrder,
	getOpenOrders,
	getOrderById,
	getOrderHistory,
	getTradeLedger,
	modifyOrder,
	parsePage,
	parsePlaceOrderInput,
	placeLimitOrder,
	placeMarketOrder,
} from "../controller/orders.js";
import { getSessionUser } from "../lib/session.js";
import requireApprovedUser from "../middleware/requireApprovedUser.js";
import requireMarketOpen from "../middleware/requireMarketOpen.js";
import type { OrderStatus } from "../models/order.js";
import { sendTradingError, TradingError } from "../trading/errors.js";

const ORDER_STATUSES: OrderStatus[] = [
	"pending",
	"filled",
	"cancelled",
	"rejected",
];

const optionalId = (value: unknown) => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const orderRouter = Router();

orderRouter.use(requireApprovedUser);

// Body: { stock_id, side: "buy" | "sell", order_type: "market" | "limit",
//         quantity, limit_price? }. The server decides whether a sell closes a
// long or opens a short, and whether a buy covers a short.
// Response: a fill ({ status: "filled", fills, position, ... }) or, for a limit
// order that is not marketable, the resting order ({ status: "pending", ... }).
orderRouter.post("/placeOrder", requireMarketOpen, async (req, res) => {
	try {
		const input = parsePlaceOrderInput(req.body);
		const userId = getSessionUser(res).id;
		const result =
			input.order_type === "limit"
				? await placeLimitOrder(userId, input)
				: await placeMarketOrder(userId, input);
		res.status(201).json(result);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { quantity?, limit_price? }. Limit orders only.
orderRouter.patch("/modifyOrder/:id", requireMarketOpen, async (req, res) => {
	try {
		const orderId = optionalId(req.params.id);
		if (!orderId) {
			throw new TradingError("ORDER_NOT_FOUND", "Order not found.");
		}
		const body = (req.body ?? {}) as Record<string, unknown>;
		const quantity =
			body.quantity === undefined ? undefined : optionalId(body.quantity);
		const limitPrice =
			body.limit_price === undefined ? undefined : Number(body.limit_price);
		if (body.quantity !== undefined && !quantity) {
			throw new TradingError(
				"INVALID_QUANTITY",
				"quantity must be a whole number of shares above zero.",
			);
		}
		if (
			limitPrice !== undefined &&
			(!Number.isFinite(limitPrice) || limitPrice <= 0)
		) {
			throw new TradingError(
				"INVALID_ORDER",
				"limit_price must be a price above zero.",
			);
		}
		if (quantity === undefined && limitPrice === undefined) {
			throw new TradingError(
				"INVALID_ORDER",
				"Send a new quantity, a new limit_price, or both.",
			);
		}
		const result = await modifyOrder(getSessionUser(res).id, orderId, {
			quantity,
			limit_price: limitPrice,
		});
		res.json(result);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Deliberately not behind requireMarketOpen: cancelling only returns the
// player's own reserved cash, it is not a trade.
orderRouter.delete("/cancelOrder/:id", async (req, res) => {
	try {
		const orderId = optionalId(req.params.id);
		if (!orderId) {
			throw new TradingError("ORDER_NOT_FOUND", "Order not found.");
		}
		res.json(await cancelOrder(getSessionUser(res).id, orderId));
	} catch (error) {
		sendTradingError(res, error);
	}
});

orderRouter.get("/getOpenOrders", async (req, res) => {
	try {
		const orders = await getOpenOrders(
			getSessionUser(res).id,
			optionalId(req.query.stock_id),
		);
		res.json(orders);
	} catch (error) {
		sendTradingError(res, error);
	}
});

orderRouter.get("/getOrderHistory", async (req, res) => {
	const status = ORDER_STATUSES.find((s) => s === req.query.status);
	try {
		const result = await getOrderHistory(getSessionUser(res).id, {
			...parsePage(req.query),
			stockId: optionalId(req.query.stock_id),
			status,
		});
		res.json(result);
	} catch (error) {
		sendTradingError(res, error);
	}
});

orderRouter.get("/getOrderById/:id", async (req, res) => {
	const orderId = optionalId(req.params.id);
	try {
		const order = orderId
			? await getOrderById(getSessionUser(res).id, orderId)
			: undefined;
		if (!order) {
			throw new TradingError("ORDER_NOT_FOUND", "Order not found.");
		}
		res.json(order);
	} catch (error) {
		sendTradingError(res, error);
	}
});

orderRouter.get("/getTradeLedger", async (req, res) => {
	try {
		const result = await getTradeLedger(getSessionUser(res).id, {
			...parsePage(req.query),
			stockId: optionalId(req.query.stock_id),
		});
		res.json(result);
	} catch (error) {
		sendTradingError(res, error);
	}
});

export default orderRouter;
