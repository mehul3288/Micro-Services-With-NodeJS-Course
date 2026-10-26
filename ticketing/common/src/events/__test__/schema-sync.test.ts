import { test, describe, it } from "node:test";
import assert from "node:assert";
import {
    schemaRegistry,
    SchemaValidationError,
    EVENT_SCHEMAS,
} from "../schema-registry";
import { Subjects } from "../subjects";
import { topicFor } from "../topics";
import { OrderStatus } from "../types/order-status";
import { TicketCreatedEvent } from "../ticket-created-event";
import { TicketUpdateEvent } from "../ticket-updated-event";
import { OrderCreatedEvent } from "../order-created-event";
import { OrderCancelledEvent } from "../order-cancelled-event";
import { PaymentCreatedEvent } from "../payment-created-event";
import { ExpirationCompleteEvent } from "../expiration-complete-event";
import { RefundRequestedEvent } from "../refund-requested-event";
import { PaymentRefundedEvent } from "../payment-refunded-event";

describe("Event Contract & Schema Synchronization Tests", () => {
    it("ensures every subject in Subjects enum has a registered JSON schema", () => {
        for (const subject of Object.values(Subjects)) {
            const schema = EVENT_SCHEMAS[subject as Subjects];
            assert.ok(schema, `Missing JSON schema for subject: ${subject}`);
            assert.ok(
                (schema as any).$schema,
                `Schema for ${subject} must declare a $schema draft`
            );
            assert.ok(
                (schema as any).properties,
                `Schema for ${subject} must declare properties`
            );
        }
    });

    it("validates TicketCreatedEvent against ticket-created.schema.json", () => {
        const payload: TicketCreatedEvent["data"] = {
            id: "6ad721fba737468959322013",
            title: "Rock Concert",
            price: 150,
            userId: "6ad0a6ef15837723c4942614",
            version: 0,
        };

        // Should not throw
        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.TicketCreated, payload);
        });
    });

    it("validates TicketUpdateEvent against ticket-updated.schema.json", () => {
        const payload: TicketUpdateEvent["data"] = {
            id: "6ad721fba737468959322013",
            title: "Rock Concert VIP",
            price: 250,
            userId: "6ad0a6ef15837723c4942614",
            version: 1,
            orderId: "6ad721fba737468959322099",
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.TicketUpdated, payload);
        });
    });

    it("validates OrderCreatedEvent against order-created.schema.json", () => {
        const payload: OrderCreatedEvent["data"] = {
            id: "6ad721fba737468959322099",
            status: OrderStatus.Created,
            userId: "6ad0a6ef15837723c4942614",
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            version: 0,
            ticket: {
                id: "6ad721fba737468959322013",
                price: 150,
            },
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.OrderCreated, payload);
        });
    });

    it("validates OrderCancelledEvent against order-cancelled.schema.json", () => {
        const payload: OrderCancelledEvent["data"] = {
            id: "6ad721fba737468959322099",
            version: 1,
            ticket: {
                id: "6ad721fba737468959322013",
            },
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.OrderCancelled, payload);
        });
    });

    it("validates PaymentCreatedEvent against payment-created.schema.json", () => {
        const payload: PaymentCreatedEvent["data"] = {
            id: "pay_123456789",
            orderId: "6ad721fba737468959322099",
            stripeId: "ch_stripe_sample_987",
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.PaymentCreated, payload);
        });
    });

    it("validates ExpirationCompleteEvent against expiration-complete.schema.json", () => {
        const payload: ExpirationCompleteEvent["data"] = {
            orderId: "6ad721fba737468959322099",
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.ExpirationComplete, payload);
        });
    });

    it("validates RefundRequestedEvent against refund-requested.schema.json", () => {
        const payload: RefundRequestedEvent["data"] = {
            orderId: "6ad721fba737468959322099",
            paymentId: "pay_123456789",
            reason: "User cancelled ticket order",
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.RefundRequested, payload);
        });
    });

    it("validates PaymentRefundedEvent against payment-refunded.schema.json", () => {
        const payload: PaymentRefundedEvent["data"] = {
            paymentId: "pay_123456789",
            orderId: "6ad721fba737468959322099",
            stripeRefundId: "re_stripe_sample_321",
        };

        assert.doesNotThrow(() => {
            schemaRegistry.validate(Subjects.PaymentRefunded, payload);
        });
    });

    it("rejects payload missing required field with SchemaValidationError", () => {
        // Missing 'price'
        const invalidPayload = {
            id: "6ad721fba737468959322013",
            title: "Incomplete Ticket",
            userId: "6ad0a6ef15837723c4942614",
            version: 0,
        };

        assert.throws(
            () => {
                schemaRegistry.validate(
                    Subjects.TicketCreated,
                    invalidPayload as any
                );
            },
            (err: any) => {
                assert.ok(err instanceof SchemaValidationError);
                assert.strictEqual(err.subject, Subjects.TicketCreated);
                assert.ok(
                    err.message.includes("must have required property 'price'")
                );
                return true;
            }
        );
    });

    it("rejects payload with incorrect field type with SchemaValidationError", () => {
        // 'price' as string instead of number
        const invalidPayload = {
            id: "6ad721fba737468959322013",
            title: "Bad Price Type",
            price: "100", // Invalid!
            userId: "6ad0a6ef15837723c4942614",
            version: 0,
        };

        assert.throws(
            () => {
                schemaRegistry.validate(
                    Subjects.TicketCreated,
                    invalidPayload as any
                );
            },
            (err: any) => {
                assert.ok(err instanceof SchemaValidationError);
                assert.ok(err.message.includes("must be number"));
                return true;
            }
        );
    });

    it("encodes and decodes event payloads with schema validation", async () => {
        const payload: TicketCreatedEvent["data"] = {
            id: "6ad721fba737468959322013",
            title: "Schema Encoded Concert",
            price: 75,
            userId: "6ad0a6ef15837723c4942614",
            version: 0,
        };

        const topic = topicFor[Subjects.TicketCreated];
        const buffer = await schemaRegistry.encode(
            topic,
            Subjects.TicketCreated,
            payload
        );
        assert.ok(Buffer.isBuffer(buffer));

        const decoded = await schemaRegistry.decode<TicketCreatedEvent["data"]>(
            topic,
            Subjects.TicketCreated,
            buffer
        );
        assert.deepStrictEqual(decoded, payload);
    });
});
