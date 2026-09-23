import { Subjects } from "./subjects";

export interface TicketUpdateEvent {
    subject: Subjects.TicketUpdated;
    data: {
        id: string;
        title: string;
        price: number;
        userId: string;
    }
}