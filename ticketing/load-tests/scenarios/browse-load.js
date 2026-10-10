import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, baseOptions, defaultHeaders } from '../lib/config.js';
import { signup } from '../lib/auth.js';
import { createTicket, listTickets } from '../lib/tickets.js';

export const options = {
    ...baseOptions,
    stages: [
        { duration: '15s', target: 20 },  // Ramp-up to 20 VUs
        { duration: '30s', target: 50 },  // Stay at 50 VUs
        { duration: '15s', target: 0 },   // Ramp-down
    ],
    thresholds: {
        http_req_failed: ['rate<0.01'],   // Error rate should be < 1%
        http_req_duration: ['p(95)<1000'], // 95% of requests should be < 1s
    },
};

export function setup() {
    console.log(`[SETUP] Seeding tickets for browse load test...`);
    const seller = signup(`seller_browse_${Date.now()}@test.com`, 'password');

    // Seed 25 tickets
    for (let i = 1; i <= 25; i++) {
        createTicket(seller.cookieHeader, `Festival Event #${i}`, 20 + i);
    }
    console.log(`[SETUP] Seeded 25 test tickets successfully.`);
}

export default function () {
    const res = listTickets();

    check(res, {
        'status is 200': (r) => r.status === 200,
        'response contains tickets': (r) => {
            const body = r.json();
            return Array.isArray(body) && body.length > 0;
        },
    });

    sleep(0.1); // Small think time
}
