import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../../app";
import { RefreshToken } from "../../models/refresh-token";
import { TokenService } from "../../services/token-service";

it("successfully rotates refresh token and returns new access token on POST /api/users/refresh", async () => {
    // 1. Sign up user
    const signupRes = await request(app)
        .post("/api/users/signup")
        .send({
            email: "refresh-user@test.com",
            password: "password123",
        })
        .expect(201);

    const cookies = signupRes.get("Set-Cookie");
    expect(cookies).toBeDefined();

    // Find refreshToken cookie
    const refreshCookie = cookies?.find((c) => c.startsWith("refreshToken="));
    expect(refreshCookie).toBeDefined();
    const rawRefreshToken = refreshCookie?.split(";")[0].split("=")[1];
    expect(rawRefreshToken).toBeDefined();

    // 2. Call refresh endpoint with cookie
    const refreshRes = await request(app)
        .post("/api/users/refresh")
        .set("Cookie", refreshCookie!)
        .send({})
        .expect(200);

    // Verify response body
    expect(refreshRes.body.email).toEqual("refresh-user@test.com");
    expect(refreshRes.body.refreshToken).toBeDefined();
    expect(refreshRes.body.refreshToken).not.toEqual(rawRefreshToken);

    // Verify new cookies
    const newCookies = refreshRes.get("Set-Cookie");
    expect(newCookies).toBeDefined();
    const newSessionCookie = newCookies?.find((c) => c.startsWith("session="));
    expect(newSessionCookie).toBeDefined();

    // Verify access JWT payload
    const sessionBase64 = newSessionCookie?.split(";")[0].split("=")[1];
    const sessionJson = JSON.parse(
        Buffer.from(sessionBase64!, "base64").toString("utf-8")
    );
    const decodedJwt = jwt.verify(
        sessionJson.jwt,
        process.env.JWT_KEY!
    ) as { id: string; email: string; exp: number };
    expect(decodedJwt.email).toEqual("refresh-user@test.com");
    expect(decodedJwt.exp).toBeDefined();

    // Verify database state: old token marked revoked, replacedBy set
    const oldHash = TokenService.hashToken(rawRefreshToken!);
    const oldDoc = await RefreshToken.findOne({ tokenHash: oldHash });
    expect(oldDoc).not.toBeNull();
    expect(oldDoc?.revokedAt).not.toBeNull();
    expect(oldDoc?.replacedBy).toEqual(
        TokenService.hashToken(refreshRes.body.refreshToken)
    );

    // Verify new token active in database and has same familyId
    const newHash = TokenService.hashToken(refreshRes.body.refreshToken);
    const newDoc = await RefreshToken.findOne({ tokenHash: newHash });
    expect(newDoc).not.toBeNull();
    expect(newDoc?.revokedAt).toBeNull();
    expect(newDoc?.familyId).toEqual(oldDoc?.familyId);
});

it("supports passing refresh token in JSON body", async () => {
    const signupRes = await request(app)
        .post("/api/users/signup")
        .send({
            email: "body-user@test.com",
            password: "password123",
        })
        .expect(201);

    const cookies = signupRes.get("Set-Cookie");
    const refreshCookie = cookies?.find((c) => c.startsWith("refreshToken="));
    const rawRefreshToken = refreshCookie?.split(";")[0].split("=")[1];

    const refreshRes = await request(app)
        .post("/api/users/refresh")
        .send({ refreshToken: rawRefreshToken })
        .expect(200);

    expect(refreshRes.body.refreshToken).toBeDefined();
    expect(refreshRes.body.email).toEqual("body-user@test.com");
});

it("rejects refresh when no token is provided", async () => {
    await request(app)
        .post("/api/users/refresh")
        .send({})
        .expect(401);
});

it("rejects refresh with an invalid/unknown token", async () => {
    await request(app)
        .post("/api/users/refresh")
        .send({ refreshToken: "completely-bogus-token-string" })
        .expect(401);
});

it("rejects refresh when token is expired", async () => {
    const signupRes = await request(app)
        .post("/api/users/signup")
        .send({
            email: "expired-user@test.com",
            password: "password123",
        })
        .expect(201);

    const cookies = signupRes.get("Set-Cookie");
    const refreshCookie = cookies?.find((c) => c.startsWith("refreshToken="));
    const rawRefreshToken = refreshCookie?.split(";")[0].split("=")[1];

    // Force expiration in DB
    const tokenHash = TokenService.hashToken(rawRefreshToken!);
    await RefreshToken.updateOne(
        { tokenHash },
        { expiresAt: new Date(Date.now() - 5000) }
    );

    await request(app)
        .post("/api/users/refresh")
        .send({ refreshToken: rawRefreshToken })
        .expect(401);
});

it("DETECTS REUSE: revokes the entire token family when an already-used token is replayed", async () => {
    // 1. Legitimate user logs in -> gets R1
    const signupRes = await request(app)
        .post("/api/users/signup")
        .send({
            email: "theft-target@test.com",
            password: "password123",
        })
        .expect(201);

    const cookies = signupRes.get("Set-Cookie");
    const refreshCookie = cookies?.find((c) => c.startsWith("refreshToken="));
    const tokenR1 = refreshCookie?.split(";")[0].split("=")[1];

    // 2. Legitimate user rotates R1 -> gets R2
    const rotate1Res = await request(app)
        .post("/api/users/refresh")
        .send({ refreshToken: tokenR1 })
        .expect(200);

    const tokenR2 = rotate1Res.body.refreshToken;
    expect(tokenR2).toBeDefined();
    expect(tokenR2).not.toEqual(tokenR1);

    // 3. ATTACK SCENARIO: Attacker presents previously-used token R1
    await request(app)
        .post("/api/users/refresh")
        .send({ refreshToken: tokenR1 })
        .expect(401);

    // 4. VERIFY FAMILY WIPEOUT: Even the legitimate user's active token R2 is now revoked!
    await request(app)
        .post("/api/users/refresh")
        .send({ refreshToken: tokenR2 })
        .expect(401);

    // Verify all tokens in that family are marked revoked in DB
    const hashR1 = TokenService.hashToken(tokenR1!);
    const docR1 = await RefreshToken.findOne({ tokenHash: hashR1 });
    const familyDocs = await RefreshToken.find({ familyId: docR1?.familyId });

    expect(familyDocs.length).toBeGreaterThanOrEqual(2);
    for (const doc of familyDocs) {
        expect(doc.revokedAt).not.toBeNull();
    }
});
