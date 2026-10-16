import { ClientSession } from "mongoose";
import { Subjects } from "./subjects";

interface Event {
    subject: Subjects;
    data: any;
}

export interface EventMetadata {
    eventId: string;
    occurredAt: string;
    session?: ClientSession;
}

export abstract class Listener<T extends Event> {
    abstract subject: T["subject"];
    abstract onMessage(data: T["data"], metadata: EventMetadata): Promise<void>;
}