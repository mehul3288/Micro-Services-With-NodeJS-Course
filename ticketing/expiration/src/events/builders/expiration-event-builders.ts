import { ExpirationCompleteEvent } from "@mehul-mrtickets/common";

export const toExpirationCompleteEvent = (orderId: string): ExpirationCompleteEvent["data"] => ({
    orderId,
});
