import http from 'k6/http';
import { BASE_URL, defaultHeaders } from './config.js';

function getAuthHeaders(cookieHeader) {
    const headers = { ...defaultHeaders };
    if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
    }
    return headers;
}

/**
 * Creates a new ticket.
 */
export function createTicket(cookieHeader, title = 'Concert Ticket', price = 20) {
    const payload = JSON.stringify({ title, price });
    const res = http.post(`${BASE_URL}/api/tickets`, payload, {
        headers: getAuthHeaders(cookieHeader),
        tags: { name: 'CreateTicket' },
    });
    return res;
}

/**
 * Fetches all tickets.
 */
export function listTickets() {
    return http.get(`${BASE_URL}/api/tickets`, {
        headers: defaultHeaders,
        tags: { name: 'ListTickets' },
    });
}

/**
 * Fetches a single ticket by id.
 */
export function getTicket(ticketId) {
    return http.get(`${BASE_URL}/api/tickets/${ticketId}`, {
        headers: defaultHeaders,
        tags: { name: 'GetTicket' },
    });
}

/**
 * Creates an order reserving a ticket.
 */
export function createOrder(cookieHeader, ticketId) {
    const payload = JSON.stringify({ ticketId });
    const res = http.post(`${BASE_URL}/api/orders`, payload, {
        headers: getAuthHeaders(cookieHeader),
        tags: { name: 'CreateOrder' },
    });
    return res;
}

/**
 * Makes a payment for an order.
 */
export function payOrder(cookieHeader, orderId, token = 'tok_visa') {
    const payload = JSON.stringify({ orderId, token });
    const res = http.post(`${BASE_URL}/api/payments`, payload, {
        headers: getAuthHeaders(cookieHeader),
        tags: { name: 'PayOrder' },
    });
    return res;
}
