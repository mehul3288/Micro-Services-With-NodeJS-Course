import CircuitBreaker from "opossum";
import Stripe from "stripe";
import { ServiceUnavailableError } from "@mehul-mrtickets/common";
import { stripe } from "../stripe";

export interface ChargeParams {
    amount: number;
    currency: string;
    source: string;
}

export const isBusinessError = (err: any): boolean => {
    if (!err) return false;
    const type = err.type || err.name;
    return type === "StripeCardError" || type === "StripeInvalidRequestError";
};

const createCharge = async (params: ChargeParams, idempotencyKey: string): Promise<Stripe.Charge> => {
    return stripe.charges.create(params, { idempotencyKey });
};

const createRefund = async (chargeId: string, idempotencyKey: string): Promise<Stripe.Refund> => {
    return stripe.refunds.create({ charge: chargeId }, { idempotencyKey });
};

export const chargeBreaker = new CircuitBreaker(createCharge, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
    resetTimeout: 30 * 1000,
    errorFilter: isBusinessError,
});

export const refundBreaker = new CircuitBreaker(createRefund, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
    resetTimeout: 30 * 1000,
    errorFilter: isBusinessError,
});

export const chargeCard = async (params: ChargeParams, idempotencyKey: string): Promise<Stripe.Charge> => {
    try {
        return await chargeBreaker.fire(params, idempotencyKey);
    } catch (err: any) {
        if (isBusinessError(err)) {
            throw err;
        }
        if (chargeBreaker.opened || err?.code === "EOPENBREAKER" || err?.code === "ETIMEDOUT") {
            throw new ServiceUnavailableError("Payment provider unavailable, please retry later");
        }
        throw new ServiceUnavailableError(err?.message || "Payment provider unavailable, please retry later");
    }
};

export const refundCharge = async (chargeId: string, idempotencyKey: string): Promise<Stripe.Refund> => {
    try {
        return await refundBreaker.fire(chargeId, idempotencyKey);
    } catch (err: any) {
        if (isBusinessError(err)) {
            throw err;
        }
        if (refundBreaker.opened || err?.code === "EOPENBREAKER" || err?.code === "ETIMEDOUT") {
            throw new ServiceUnavailableError("Payment provider unavailable, please retry later");
        }
        throw new ServiceUnavailableError(err?.message || "Payment provider unavailable, please retry later");
    }
};
