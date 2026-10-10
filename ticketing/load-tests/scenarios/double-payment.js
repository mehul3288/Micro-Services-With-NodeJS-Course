import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, baseOptions, defaultHeaders } from '../lib/config.js';
import { signup } from '../lib/auth.js';
import { createTicket, createOrder } from '../lib/tickets.js';

export const paymentsCreated = new Counter('payments_created');
export const paymentsRejected = new Counter('payments_rejected');
export const unexpectedErrors = new Counter('unexpected_errors');

const BATCH_SIZE = 10;

export const options = {
    ...baseOptions,
    vus: 1,
    iterations: 1,
};

export function setup() {
    console.log(`[SETUP] Registering seller, buyer, creating ticket and order...`);
    const seller = signup(`seller_pay_${Date.now()}@test.com`, 'password');
    const ticketRes = createTicket(seller.cookieHeader, 'VIP Concert Pass', 99);
    const ticket = ticketRes.json();

    const buyer = signup(`buyer_pay_${Date.now()}@test.com`, 'password');
    const orderRes = createOrder(buyer.cookieHeader, ticket.id);

    if (orderRes.status !== 201) {
        throw new Error(`Failed to create order: ${orderRes.status} ${orderRes.body}`);
    }

    const order = orderRes.json();
    console.log(`[SETUP] Created Order ID=${order.id} for Ticket ID=${ticket.id}`);

    return {
        orderId: order.id,
        cookieHeader: buyer.cookieHeader,
    };
}

/**
 * Fires 10 concurrent payment requests in parallel via http.batch()
 */
export default function (data) {
    const requests = [];
    const payload = JSON.stringify({
        orderId: data.orderId,
        token: 'tok_visa',
    });

    const headers = {
        ...defaultHeaders,
        Cookie: data.cookieHeader,
    };

    for (let i = 0; i < BATCH_SIZE; i++) {
        requests.push({
            method: 'POST',
            url: `${BASE_URL}/api/payments`,
            body: payload,
            params: {
                headers,
                tags: { name: 'BatchPayment' },
            },
        });
    }

    console.log(`[ATTACK] Firing batch of ${BATCH_SIZE} simultaneous payments for Order ${data.orderId}...`);
    const responses = http.batch(requests);

    for (const res of responses) {
        if (res.status === 201) {
            paymentsCreated.add(1);
        } else if (res.status === 400) {
            paymentsRejected.add(1);
        } else {
            unexpectedErrors.add(1);
            console.error(`Unexpected response status ${res.status}: ${res.body}`);
        }

        check(res, {
            'valid HTTP response': (r) => r.status === 201 || r.status === 400,
        });
    }
}

export function teardown(data) {
    console.log(`[TEARDOWN] Double-payment test completed for Order ${data.orderId}`);
}
