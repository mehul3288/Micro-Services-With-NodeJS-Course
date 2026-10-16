import request from "supertest";
import { app } from "../../app";

jest.mock("../../stripe");

it("returns Prometheus metrics at /metrics", async () => {
    const res = await request(app).get("/metrics").expect(200);
    expect(res.text).toContain("ticketing_");
});
