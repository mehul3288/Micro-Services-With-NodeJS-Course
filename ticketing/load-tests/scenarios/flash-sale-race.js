import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, baseOptions, defaultHeaders } from '../lib/config.js';
import { signup } from '../lib/auth.js';
import { createTicket } from '../lib/tickets.js';

// Custom metrics to measure the race condition
export const ordersCreated = new Counter('orders_created');
export const ordersRejected = new Counter('orders_rejected');
export const unexpectedErrors = new Counter('unexpected_errors');

const NUM_BUYERS = 50;

export const options = {
    ...baseOptions,
    vus: 1,
    iterations: 1,
};

/**
 * Setup runs once before VUs execute.
 * 1. Creates a seller account and publishes 1 ticket.
 * 2. Pre-registers all buyers and collects their auth session cookies.
 */
export function setup() {
    console.log(`[SETUP] Registering seller and creating 1 test ticket...`);
    const seller = signup(`seller_flash_${Date.now()}@test.com`, 'password');
    const ticketRes = createTicket(seller.cookieHeader, 'Flash Sale Ticket', 75);

    if (ticketRes.status !== 201) {
        throw new Error(`Failed to create ticket: ${ticketRes.status} ${ticketRes.body}`);
    }

    const ticket = ticketRes.json();
    console.log(`[SETUP] Ticket created: ID=${ticket.id}, Title="${ticket.title}"`);

    console.log(`[SETUP] Pre-registering ${NUM_BUYERS} buyers...`);
    const buyers = [];
    for (let i = 0; i < NUM_BUYERS; i++) {
        const buyer = signup(`buyer_flash_${Date.now()}_${i}@test.com`, 'password');
        buyers.push({
            cookieHeader: buyer.cookieHeader,
            email: buyer.email,
        });
    }
    console.log(`[SETUP] Setup complete! All ${NUM_BUYERS} buyers registered.`);

    return {
        ticketId: ticket.id,
        buyers,
    };
}

/**
 * Fires simultaneous POST /api/orders requests in parallel across all buyers via http.batch().
 */
export default function (data) {
    const payload = JSON.stringify({ ticketId: data.ticketId });
    const requests = data.buyers.map((buyer) => ({
        method: 'POST',
        url: `${BASE_URL}/api/orders`,
        body: payload,
        params: {
            headers: {
                ...defaultHeaders,
                Cookie: buyer.cookieHeader,
            },
            tags: { name: 'BatchOrder' },
        },
    }));

    console.log(`[ATTACK] Firing batch of ${requests.length} simultaneous orders for Ticket ${data.ticketId}...`);
    const responses = http.batch(requests);

    for (const res of responses) {
        if (res.status === 201) {
            ordersCreated.add(1);
        } else if (res.status === 400) {
            ordersRejected.add(1);
        } else {
            unexpectedErrors.add(1);
            console.error(`Unexpected response status ${res.status}: ${res.body}`);
        }

        check(res, {
            'status is 201 or 400': (r) => r.status === 201 || r.status === 400,
        });
    }
}

export function teardown(data) {
    console.log(`[TEARDOWN] Flash-sale race scenario finished for ticket ${data.ticketId}`);
}
