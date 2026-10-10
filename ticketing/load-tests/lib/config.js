export const BASE_URL = __ENV.BASE_URL || 'https://ticketing.dev';

export const defaultHeaders = {
    'Content-Type': 'application/json',
};

export const baseOptions = {
    insecureSkipTLSVerify: true,
};
