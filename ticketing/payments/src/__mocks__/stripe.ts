export const stripe = {
    charges: {
        create: jest.fn().mockResolvedValue({ id: "ch_test_123" }),
    },
    refunds: {
        create: jest.fn().mockResolvedValue({ id: "re_test_123" }),
    },
};
