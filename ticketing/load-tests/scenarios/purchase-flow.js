import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, baseOptions } from '../lib/config.js';
import { signup } from '../lib/auth.js';
import { createTicket, createOrder, payOrder } from '../lib/tickets.js';

// Custom trends for step-by-step latency tracking
export const signupLatency = new Trend('step_signup_duration');
export const createTicketLatency = new Trend('step_create_ticket_duration');
export const createOrderLatency = new Trend('step_create_order_duration');
export const payOrderLatency = new Trend('step_pay_order_duration');
export const completedFlows = new Counter('completed_purchase_flows');
export const failedFlows = new Counter('failed_purchase_flows');

export const options = {
    ...baseOptions,
    stages: [
        { duration: '20s', target: 10 }, // Ramp-up to 10 VUs
        { duration: '40s', target: 20 }, // Maintain 20 concurrent purchase flows
        { duration: '15s', target: 0 },  // Ramp-down
    ],
    thresholds: {
        http_req_failed: ['rate<0.05'], // Max 5% failures
        'step_pay_order_duration': ['p(95)<2500'],
    },
};

export default function () {
    const userEmail = `user_flow_${__VU}_${__ITER}_${Date.now()}@test.com`;

    // Step 1: Signup
    const t0 = Date.now();
    let authUser;
    try {
        authUser = signup(userEmail, 'password');
        signupLatency.add(Date.now() - t0);
    } catch (err) {
        failedFlows.add(1);
        return;
    }

    // Step 2: Create a ticket
    const t1 = Date.now();
    const ticketRes = createTicket(authUser.cookieHeader, `Show Pass ${__VU}-${__ITER}`, 45);
    createTicketLatency.add(Date.now() - t1);

    const ticketOk = check(ticketRes, {
        'ticket created (201)': (r) => r.status === 201,
    });

    if (!ticketOk) {
        failedFlows.add(1);
        return;
    }
    const ticket = ticketRes.json();

    // Small delay between listing and buying
    sleep(0.5);

    // Step 3: Create order (as buyer)
    // Create a separate buyer so user doesn't buy own ticket (if application restricts, though current orders service doesn't restrict)
    const buyerEmail = `buyer_flow_${__VU}_${__ITER}_${Date.now()}@test.com`;
    let buyerAuth;
    try {
        buyerAuth = signup(buyerEmail, 'password');
    } catch (err) {
        failedFlows.add(1);
        return;
    }

    const t2 = Date.now();
    const orderRes = createOrder(buyerAuth.cookieHeader, ticket.id);
    createOrderLatency.add(Date.now() - t2);

    const orderOk = check(orderRes, {
        'order created (201)': (r) => r.status === 201,
    });

    if (!orderOk) {
        failedFlows.add(1);
        return;
    }
    const order = orderRes.json();

    sleep(0.5);

    // Step 4: Pay for the order
    const t3 = Date.now();
    const payRes = payOrder(buyerAuth.cookieHeader, order.id, 'tok_visa');
    payOrderLatency.add(Date.now() - t3);

    const payOk = check(payRes, {
        'payment succeeded (201)': (r) => r.status === 201,
    });

    if (payOk) {
        completedFlows.add(1);
    } else {
        failedFlows.add(1);
    }

    sleep(1);
}
