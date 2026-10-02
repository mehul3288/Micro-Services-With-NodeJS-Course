import { ExpirationCompleteEvent, Publisher, Subjects } from "@mehul-mrtickets/common";

export class ExpirationCompletePublisher extends Publisher<ExpirationCompleteEvent> {
    subject: Subjects.ExpirationComplete = Subjects.ExpirationComplete;

}