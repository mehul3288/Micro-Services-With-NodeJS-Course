import { SchemaRegistry, SchemaType, COMPATIBILITY } from "@kafkajs/confluent-schema-registry";
import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Subjects } from "./subjects";
import { topicFor } from "./topics";

import ticketCreatedSchema from "./schemas/ticket-created.schema.json";
import ticketUpdatedSchema from "./schemas/ticket-updated.schema.json";
import orderCreatedSchema from "./schemas/order-created.schema.json";
import orderCancelledSchema from "./schemas/order-cancelled.schema.json";
import paymentCreatedSchema from "./schemas/payment-created.schema.json";
import expirationCompleteSchema from "./schemas/expiration-complete.schema.json";
import refundRequestedSchema from "./schemas/refund-requested.schema.json";
import paymentRefundedSchema from "./schemas/payment-refunded.schema.json";

export class SchemaValidationError extends Error {
    public readonly errors: any[];
    public readonly subject: string;

    constructor(subject: string, errors: any[]) {
        super(`Schema validation failed for subject [${subject}]: ${JSON.stringify(errors)}`);
        this.name = "SchemaValidationError";
        this.subject = subject;
        this.errors = errors;
        Object.setPrototypeOf(this, SchemaValidationError.prototype);
    }
}

export const EVENT_SCHEMAS: Record<Subjects, object> = {
    [Subjects.TicketCreated]: ticketCreatedSchema,
    [Subjects.TicketUpdated]: ticketUpdatedSchema,
    [Subjects.OrderCreated]: orderCreatedSchema,
    [Subjects.OrderCancelled]: orderCancelledSchema,
    [Subjects.PaymentCreated]: paymentCreatedSchema,
    [Subjects.ExpirationComplete]: expirationCompleteSchema,
    [Subjects.RefundRequested]: refundRequestedSchema,
    [Subjects.PaymentRefunded]: paymentRefundedSchema,
};

export class SchemaRegistryManager {
    private registry: SchemaRegistry | null = null;
    private ajv: Ajv;
    private validators: Map<string, ValidateFunction> = new Map();
    private schemaIds: Map<string, number> = new Map();
    private isInitialized = false;

    constructor() {
        this.ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(this.ajv);

        // Precompile ajv validators for fast in-memory validation
        for (const [subject, schema] of Object.entries(EVENT_SCHEMAS)) {
            const validator = this.ajv.compile(schema);
            this.validators.set(subject, validator);
        }
    }

    /**
     * Compute Confluent Schema Registry subject name using RecordNameStrategy:
     * e.g. "ticket-events-TicketCreated"
     */
    public getSubjectName(subject: Subjects | string): string {
        const topic = (topicFor as Record<string, string>)[subject];
        // Normalize subject name (e.g. "ticket:created" -> "TicketCreated")
        const pascalName = subject
            .split(/[:\-_]/)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");
        return topic ? `${topic}-${pascalName}` : pascalName;
    }

    /**
     * Initialize connection to Confluent Schema Registry and register all schemas
     * with BACKWARD compatibility mode enforced.
     */
    public async init(registryUrl?: string): Promise<void> {
        const url = registryUrl || process.env.SCHEMA_REGISTRY_URL;
        if (!url) {
            console.log("[SchemaRegistry] No SCHEMA_REGISTRY_URL specified; operating in local validator mode.");
            this.isInitialized = true;
            return;
        }

        try {
            console.log(`[SchemaRegistry] Connecting to registry at ${url}...`);
            this.registry = new SchemaRegistry({ host: url });

            for (const [subjKey, schemaObj] of Object.entries(EVENT_SCHEMAS)) {
                const subjectName = this.getSubjectName(subjKey);
                const schemaString = JSON.stringify(schemaObj);

                const { id } = await this.registry.register(
                    {
                        type: SchemaType.JSON,
                        schema: schemaString,
                    },
                    {
                        subject: subjectName,
                        compatibility: COMPATIBILITY.BACKWARD,
                    }
                );

                this.schemaIds.set(subjKey, id);
                console.log(`[SchemaRegistry] Registered subject '${subjectName}' -> Schema ID: ${id}`);
            }

            this.isInitialized = true;
            console.log("[SchemaRegistry] All event schemas registered successfully with BACKWARD compatibility.");
        } catch (err: any) {
            console.error(`[SchemaRegistry] Fatal startup error during schema registration: ${err.message}`);
            throw err;
        }
    }

    /**
     * Validate an event payload using AJV.
     */
    public validate(subject: Subjects | string, data: any): void {
        const validator = this.validators.get(subject);
        if (validator) {
            const valid = validator(data);
            if (!valid) {
                throw new SchemaValidationError(subject, validator.errors || []);
            }
        }
    }

    /**
     * Encode an event payload into Confluent Wire Format ([0x00][4-byte Schema ID][JSON]).
     * Validates schema before encoding.
     */
    public async encode(topic: string, subject: Subjects | string, data: any): Promise<Buffer> {
        // Step 1: Validate payload structure
        this.validate(subject, data);

        // Step 2: If registry is active and schema ID exists, encode with Confluent Wire Format
        const schemaId = this.schemaIds.get(subject);
        if (this.registry && schemaId !== undefined) {
            return await this.registry.encode(schemaId, data);
        }

        // Fallback: UTF-8 JSON buffer
        return Buffer.from(JSON.stringify(data), "utf-8");
    }

    /**
     * Decode a message payload from Kafka.
     * Handles both Confluent Wire Format (magic byte 0x00) and raw JSON buffers.
     * Enforces schema validation.
     */
    public async decode<T = any>(topic: string, subject: Subjects | string, buffer: Buffer): Promise<T> {
        if (!buffer || buffer.length === 0) {
            return {} as T;
        }

        let payload: any;

        // Check for Confluent Magic Byte (0x00)
        if (buffer[0] === 0x00 && this.registry && buffer.length >= 5) {
            try {
                payload = await this.registry.decode(buffer);
            } catch (err: any) {
                console.warn(`[SchemaRegistry] Registry decode failed, falling back to JSON.parse: ${err.message}`);
                payload = JSON.parse(buffer.toString("utf-8"));
            }
        } else {
            // Raw JSON string / legacy buffer
            payload = JSON.parse(buffer.toString("utf-8"));
        }

        // Step 2: Validate decoded payload against expected subject schema
        this.validate(subject, payload);

        return payload as T;
    }

    /**
     * Get underlying SchemaRegistry client instance (for testing).
     */
    public getRegistry(): SchemaRegistry | null {
        return this.registry;
    }
}

export const schemaRegistry = new SchemaRegistryManager();
