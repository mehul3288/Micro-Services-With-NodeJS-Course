import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, defaultHeaders } from './config.js';

/**
 * Creates a unique user and returns the authentication cookie.
 * @param {string} [customEmail]
 * @param {string} [customPassword]
 * @returns {{ email: string, userId: string, cookieHeader: string }}
 */
export function signup(customEmail, customPassword) {
    const randomSuffix = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const email = customEmail || `loadtest_${randomSuffix}@test.com`;
    const password = customPassword || 'password';

    const payload = JSON.stringify({ email, password });
    const res = http.post(`${BASE_URL}/api/users/signup`, payload, {
        headers: defaultHeaders,
        tags: { name: 'Signup' },
    });

    const isOk = check(res, {
        'signup succeeded (201)': (r) => r.status === 201,
    });

    if (!isOk) {
        throw new Error(`Failed to sign up test user: status ${res.status} body: ${res.body}`);
    }

    const body = res.json();
    const userId = body.id || (body.currentUser && body.currentUser.id);

    // Extract cookie from response
    let cookieHeader = '';
    const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'];
    if (setCookie) {
        // May contain multiple cookies separated by comma or semicolon
        // We only need the session cookie part
        cookieHeader = setCookie.split(';')[0];
    }

    return {
        email,
        userId,
        cookieHeader,
    };
}
