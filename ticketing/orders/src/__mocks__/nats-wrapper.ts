export const natsWrapper = {
    isConnected: true,
    client: {
        publish: jest.fn().mockImplementation((subject: string, data: string, callback: () => void) => {
            callback();
        })
    }
};