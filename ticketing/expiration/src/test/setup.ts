jest.mock("../kafka-wrapper");

beforeAll(async () => {
    process.env.JWT_KEY = "asdf";
});

beforeEach(async () => {
    jest.clearAllMocks();
});
