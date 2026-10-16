import { Subjects } from "./subjects";

export interface RefundRequestedEvent {
    subject: Subjects.RefundRequested;
    data: {
        orderId: string;
        paymentId: string;
        reason?: string;
    };
}
