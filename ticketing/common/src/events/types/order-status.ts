export enum OrderStatus {
    // When the order is first created, but the ticket it is trying to order has not been reserved yet
    Created = 'created',
    // When the ticket the order is trying to order has been reserved by another order
    Cancelled = 'cancelled',
    // When the ticket the order is trying to order has been paid for
    AwaitingPayment = 'awaiting:payment',
    // When the ticket the order is trying to order has been successfully paid for
    Complete = 'complete'
}