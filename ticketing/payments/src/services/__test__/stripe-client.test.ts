import { isBusinessError, chargeCard, chargeBreaker } from "../stripe-client";
import { stripe } from "../../stripe";
import { ServiceUnavailableError } from "@mehul-mrtickets/common";

jest.mock("../../stripe");

describe("Stripe Circuit Breaker", () => {
    beforeEach(() => {
        chargeBreaker.close();
        chargeBreaker.clearCache();
        if ((chargeBreaker as any).status?.window) {
            (chargeBreaker as any).status.window.forEach((bucket: any) => {
                bucket.failures = 0;
                bucket.successes = 0;
                bucket.fires = 0;
                bucket.timeouts = 0;
                bucket.rejects = 0;
            });
        }
        (stripe.charges.create as jest.Mock).mockReset();
    });

    it("correctly identifies business errors vs infrastructure errors", () => {
        expect(isBusinessError({ type: "StripeCardError" })).toBe(true);
        expect(isBusinessError({ name: "StripeCardError" })).toBe(true);
        expect(isBusinessError({ type: "StripeInvalidRequestError" })).toBe(true);

        expect(isBusinessError({ type: "StripeConnectionError" })).toBe(false);
        expect(isBusinessError({ type: "StripeAPIError" })).toBe(false);
        expect(isBusinessError(new Error("Network timeout"))).toBe(false);
    });

    it("does not trip the circuit breaker on card declines (business errors)", async () => {
        const cardDeclineError = new Error("Card declined");
        (cardDeclineError as any).type = "StripeCardError";

        (stripe.charges.create as jest.Mock).mockRejectedValue(cardDeclineError);

        for (let i = 0; i < 6; i++) {
            await expect(
                chargeCard({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }, `idemp-${i}`)
            ).rejects.toThrow("Card declined");
        }

        // Circuit breaker should NOT be opened
        expect(chargeBreaker.opened).toBe(false);
    });

    it("opens circuit breaker after repeated infrastructure failures and fails fast with 503", async () => {
        const networkError = new Error("Connection timed out to api.stripe.com");
        (networkError as any).type = "StripeConnectionError";

        (stripe.charges.create as jest.Mock).mockRejectedValue(networkError);

        // Fail 5 times (volumeThreshold = 5, errorThresholdPercentage = 50%)
        for (let i = 0; i < 5; i++) {
            await expect(
                chargeCard({ amount: 1000, currency: "usd", source: "tok_visa" }, `idemp-${i}`)
            ).rejects.toThrow(ServiceUnavailableError);
        }

        // Breaker must now be open
        expect(chargeBreaker.opened).toBe(true);

        // Reset mock call count to verify Stripe is NOT called when breaker is open
        (stripe.charges.create as jest.Mock).mockClear();

        // 6th call should fail immediately with ServiceUnavailableError without calling Stripe
        await expect(
            chargeCard({ amount: 1000, currency: "usd", source: "tok_visa" }, "idemp-fast-fail")
        ).rejects.toThrow(ServiceUnavailableError);

        expect(stripe.charges.create).not.toHaveBeenCalled();
    });
});
