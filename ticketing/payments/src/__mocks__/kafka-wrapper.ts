export const kafkaWrapper = {
    isConnected: true,
    producer: {
        send: jest.fn().mockResolvedValue([]),
    },
    kafka: {},
};
