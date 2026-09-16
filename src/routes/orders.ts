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
import requireOnboarded from "../middleware/requireOnboarded.js";
import type { OrderStatus } from "../models/order.js";
import { sendTradingError, TradingError } from "../trading/errors.js";
import { getTradeContext, previewOrder } from "../trading/preview.js";

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

// Body: { stock_id, action: "buy" | "sell" | "short" | "cover",
//         order_type: "market" | "limit", quantity, limit_price? }.
// An action that does not fit the position is refused (POSITION_CONFLICT,
// NO_POSITION, INVALID_QUANTITY). A bare side instead of an action is still
// accepted from older callers, and then the position decides what it does.
// Response: a fill ({ status: "filled", fills, position, ... }) or, for a limit
// order that is not marketable, the resting order ({ status: "pending", ... }).
orderRouter.post("/placeOrder", requireOnboarded, requireMarketOpen, async (req, res) => {
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

// ?stock_id=&limit_price= The player's position in a stock and what Buy, Sell,
// Short and Cover can each do right now, sized at the limit price if given.
orderRouter.get("/getTradeContext", async (req, res) => {
	try {
		const stockId = optionalId(req.query.stock_id);
		if (!stockId) {
			throw new TradingError("STOCK_NOT_FOUND", "Stock not found.");
		}
		const limit = req.query.limit_price === undefined ? undefined : Number(req.query.limit_price);
		res.json(
			await getTradeContext(
				getSessionUser(res).id,
				stockId,
				limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : undefined,
			),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: as placeOrder, with an action. Answers what the order would do
// ({ ok: true, legs, cash_change, position_after, ... }) or why it would be
// refused ({ ok: false, code, message }), without placing it.
orderRouter.post("/previewOrder", async (req, res) => {
	try {
		const input = parsePlaceOrderInput(req.body);
		if (!input.action) {
			throw new TradingError("INVALID_ORDER", 'action must be "buy", "sell", "short" or "cover".');
		}
		res.json(
			await previewOrder(getSessionUser(res).id, {
				stock_id: input.stock_id,
				action: input.action,
				order_type: input.order_type,
				quantity: input.quantity,
				limit_price: input.limit_price,
			}),
		);
	} catch (error) {
		sendTradingError(res, error);
	}
});

// Body: { quantity?, limit_price? }. Limit orders only.
orderRouter.patch("/modifyOrder/:id", requireOnboarded, requireMarketOpen, async (req, res) => {
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
