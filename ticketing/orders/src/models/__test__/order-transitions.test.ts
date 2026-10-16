import { OrderStatus } from "@mehul-mrtickets/common";
import { canTransition } from "../order-transitions";

describe("Order State Transitions", () => {
    it("allows valid transitions from Created", () => {
        expect(canTransition(OrderStatus.Created, OrderStatus.AwaitingPayment)).toBe(true);
        expect(canTransition(OrderStatus.Created, OrderStatus.Complete)).toBe(true);
        expect(canTransition(OrderStatus.Created, OrderStatus.Cancelled)).toBe(true);
        expect(canTransition(OrderStatus.Created, OrderStatus.Created)).toBe(false);
    });

    it("allows valid transitions from AwaitingPayment", () => {
        expect(canTransition(OrderStatus.AwaitingPayment, OrderStatus.Complete)).toBe(true);
        expect(canTransition(OrderStatus.AwaitingPayment, OrderStatus.Cancelled)).toBe(true);
        expect(canTransition(OrderStatus.AwaitingPayment, OrderStatus.Created)).toBe(false);
        expect(canTransition(OrderStatus.AwaitingPayment, OrderStatus.AwaitingPayment)).toBe(false);
    });

    it("forbids all transitions from terminal Complete state", () => {
        expect(canTransition(OrderStatus.Complete, OrderStatus.Created)).toBe(false);
        expect(canTransition(OrderStatus.Complete, OrderStatus.AwaitingPayment)).toBe(false);
        expect(canTransition(OrderStatus.Complete, OrderStatus.Cancelled)).toBe(false);
        expect(canTransition(OrderStatus.Complete, OrderStatus.Complete)).toBe(false);
    });

    it("forbids all transitions from terminal Cancelled state", () => {
        expect(canTransition(OrderStatus.Cancelled, OrderStatus.Created)).toBe(false);
        expect(canTransition(OrderStatus.Cancelled, OrderStatus.AwaitingPayment)).toBe(false);
        expect(canTransition(OrderStatus.Cancelled, OrderStatus.Complete)).toBe(false);
        expect(canTransition(OrderStatus.Cancelled, OrderStatus.Cancelled)).toBe(false);
    });
});
