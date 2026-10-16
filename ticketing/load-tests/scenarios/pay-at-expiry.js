import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL, baseOptions, defaultHeaders } from '../lib/config.js';
import { signup } from '../lib/auth.js';
import { createTicket, createOrder } from '../lib/tickets.js';

export const guardedPayments = new Counter('guarded_payments_rejected');
export const successfulPayments = new Counter('successful_payments');
export const expiredPayments = new Counter('expired_payments_rejected');

export const options = {
    ...baseOptions,
    vus: 5,
    iterations: 20,
};

export default function () {
    const timestamp = `${Date.now()}_${Math.random()}`;
    const seller = signup(`seller_exp_${timestamp}@test.com`, 'password');
    const ticketRes = createTicket(seller.cookieHeader, `Expiring Concert Pass ${timestamp}`, 25);
    const ticket = ticketRes.json();

    const buyer = signup(`buyer_exp_${timestamp}@test.com`, 'password');
    const orderRes = createOrder(buyer.cookieHeader, ticket.id);

    if (orderRes.status !== 201) {
        return;
    }

    const order = orderRes.json();
    const expiresAt = new Date(order.expiresAt).getTime();

    // Calculate how long until expiry is within the 5-second guard window
    const now = Date.now();
    const msUntilGuardWindow = (expiresAt - now) - 4000; // 4 seconds before expiry

    if (msUntilGuardWindow > 0 && msUntilGuardWindow < 120000) {
        // Wait until we are inside the < 5s pre-expiry window
        sleep(msUntilGuardWindow / 1000);
    }

    // Attempt payment inside the < 5s guard window
    const payRes = http.post(
        `${BASE_URL}/api/payments`,
        JSON.stringify({
            orderId: order.id,
            token: 'tok_visa',
        }),
        {
            headers: {
                ...defaultHeaders,
                Cookie: buyer.cookieHeader,
            },
            tags: { name: 'PayNearExpiry' },
        }
    );

    if (payRes.status === 400) {
        const body = payRes.json();
        const msg = body.errors?.[0]?.message || '';
        if (msg.includes('about to expire') || msg.includes('expired')) {
            guardedPayments.add(1);
        } else if (msg.includes('cancelled')) {
            expiredPayments.add(1);
        }
    } else if (payRes.status === 201) {
        successfulPayments.add(1);
    }

    check(payRes, {
        'status is 400 (guarded) or 201 (success)': (r) => r.status === 400 || r.status === 201,
    });
}
