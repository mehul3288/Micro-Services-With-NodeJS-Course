import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_KEY || "dummy_key", {
    apiVersion: "2026-09-30.endive",
    timeout: 5000,
    maxNetworkRetries: 2,
    ...(process.env.STRIPE_HOST ? { host: process.env.STRIPE_HOST } : {}),
});
