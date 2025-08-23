"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const ws_1 = __importStar(require("ws"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const firebase_admin_1 = __importDefault(require("./firebase-admin"));
const client_1 = require("@prisma/client");
const jose_1 = require("jose");
const crypto_1 = require("crypto");
// Friday moduly
const routes_1 = __importDefault(require("./friday/routes"));
const config_1 = require("./friday/config");
const db_1 = require("./friday/db");
// ───────────────────────────────────────────────────────────────────────────────
// Inicializácie
const prisma = new client_1.PrismaClient();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// CORS (vrátane vercel preview domén)
const allowedOrigins = new Set([
    "https://frontendtokeny.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]);
app.use((0, cors_1.default)({
    origin(origin, callback) {
        if (!origin)
            return callback(null, true);
        try {
            const url = new URL(origin);
            const ok = allowedOrigins.has(origin) || /\.vercel\.app$/.test(url.hostname);
            if (ok)
                return callback(null, true);
        }
        catch { }
        return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
}));
// HTTP + WS server
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server }); // path nepoužijem → funguje s ws://host:PORT
// ───────────────────────────────────────────────────────────────────────────────
// Clerk JWT (pre REST). WS registrácia ostáva kompatibilná s FE (posiela userId + deviceId).
const ISSUER = process.env.CLERK_ISSUER;
if (!ISSUER)
    console.warn("⚠️  Missing CLERK_ISSUER in env!");
const JWKS = ISSUER ? (0, jose_1.createRemoteJWKSet)(new URL(`${ISSUER}/.well-known/jwks.json`)) : null;
async function getUserIdFromAuthHeader(req) {
    try {
        const auth = req.header("authorization") || req.header("Authorization");
        if (!auth?.startsWith("Bearer "))
            return null;
        const token = auth.slice("Bearer ".length);
        if (!JWKS || !ISSUER)
            return null;
        const { payload } = await (0, jose_1.jwtVerify)(token, JWKS, { issuer: ISSUER });
        return payload.sub || null;
    }
    catch (e) {
        console.error("JWT verify error:", e);
        return null;
    }
}
// userId -> (deviceId -> socket)
const clients = new Map();
const PENDING_TTL_MS = 3 * 60 * 1000; // 3 min
const pendingCalls = new Map(); // kľúč: calleeId (admin)
const callCtxById = new Map();
const activeCalls = new Map();
const PRICE_PER_SECOND = 0.125;
function callKeyFor(a, b) {
    return [a, b].sort().join("__");
}
async function ensureUser(userId) {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}
// WS send helpery
function sendToUser(userId, msg, targetDeviceId) {
    const map = clients.get(userId);
    if (!map)
        return;
    const json = JSON.stringify(msg);
    if (targetDeviceId) {
        const sock = map.get(targetDeviceId);
        if (sock && sock.readyState === ws_1.default.OPEN) {
            try {
                sock.send(json);
            }
            catch { }
        }
        return;
    }
    for (const sock of map.values()) {
        if (sock.readyState === ws_1.default.OPEN) {
            try {
                sock.send(json);
            }
            catch { }
        }
    }
}
function sendToUserExceptDevice(userId, exceptDeviceId, msg) {
    const map = clients.get(userId);
    if (!map)
        return;
    const json = JSON.stringify(msg);
    for (const [devId, sock] of map.entries()) {
        if (devId === exceptDeviceId)
            continue;
        if (sock.readyState === ws_1.default.OPEN) {
            try {
                sock.send(json);
            }
            catch { }
        }
    }
}
// FCM push
async function sendPushToAllUserDevices(userId, payload) {
    const rows = await prisma.pushToken.findMany({ where: { userId } });
    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (!tokens.length)
        return;
    const resp = await firebase_admin_1.default.messaging().sendEachForMulticast({
        tokens,
        notification: payload.notification,
        data: payload.data,
    });
    const toDelete = [];
    resp.responses.forEach((r, i) => {
        if (!r.success) {
            const code = r.error?.code;
            if (code === "messaging/registration-token-not-registered" ||
                code === "messaging/invalid-registration-token") {
                toDelete.push(tokens[i]);
            }
        }
    });
    if (toDelete.length) {
        await prisma.pushToken.deleteMany({ where: { token: { in: toDelete } } });
    }
}
// ───────────────────────────────────────────────────────────────────────────────
// REST ROUTES
// 1) Po prihlásení z FE → upsert usera (kvôli FK)
app.post("/sync-user", async (req, res) => {
    const userId = await getUserIdFromAuthHeader(req);
    if (!userId)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        await ensureUser(userId);
        return res.json({ ok: true });
    }
    catch (e) {
        console.error("sync-user error:", e);
        return res.status(500).json({ error: "Server error" });
    }
});
// 2) Registrácia/aktualizácia FCM tokenu
app.post("/register-fcm", async (req, res) => {
    const userId = await getUserIdFromAuthHeader(req);
    if (!userId)
        return res.status(401).json({ error: "Unauthenticated" });
    const body = (req.body || {});
    const { fcmToken, platform } = body;
    if (!fcmToken)
        return res.status(400).json({ error: "Missing fcmToken" });
    try {
        await ensureUser(userId);
        await prisma.pushToken.upsert({
            where: { token: fcmToken },
            update: { userId, platform: platform || null },
            create: { userId, token: fcmToken, platform: platform || null },
        });
        return res.json({ success: true });
    }
    catch (e) {
        console.error("register-fcm error:", e);
        return res.status(500).json({ error: "Server error" });
    }
});
// 3) Friday routes
app.use("/", (0, routes_1.default)(prisma));
// 4) REST fallback: zisti pending prichádzajúci hovor pre aktuálneho užívateľa (admina)
app.get("/calls/pending", async (req, res) => {
    try {
        const userId = await getUserIdFromAuthHeader(req);
        if (!userId)
            return res.status(401).json({ error: "Unauthenticated" });
        const p = pendingCalls.get(userId);
        if (p && Date.now() - p.ts <= PENDING_TTL_MS) {
            return res.json({
                pending: {
                    callId: p.callId,
                    callerId: p.callerId,
                    callerName: p.callerName,
                    expiresInMs: Math.max(0, PENDING_TTL_MS - (Date.now() - p.ts)),
                },
            });
        }
        return res.json({ pending: null });
    }
    catch (e) {
        console.error("calls/pending error:", e);
        return res.status(500).json({ error: "Server error" });
    }
});
// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET
wss.on("connection", (raw) => {
    const ws = raw;
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", async (message) => {
        try {
            const str = message.toString();
            const data = JSON.parse(str);
            const type = typeof data.type === "string" ? data.type : undefined;
            // REGISTER
            if (type === "register") {
                const userId = typeof data.userId === "string" ? data.userId : null;
                const deviceId = typeof data.deviceId === "string" ? data.deviceId : null;
                if (!userId || !deviceId)
                    return;
                ws.userId = userId;
                ws.deviceId = deviceId;
                let devMap = clients.get(userId);
                if (!devMap) {
                    devMap = new Map();
                    clients.set(userId, devMap);
                }
                devMap.set(deviceId, ws);
                console.log(`✅ WS register user=${userId} device=${deviceId} (devices now: ${devMap.size})`);
                // doruč pending "incoming-call", ak existuje
                const pending = pendingCalls.get(userId);
                if (pending && Date.now() - pending.ts <= PENDING_TTL_MS) {
                    try {
                        ws.send(JSON.stringify({
                            type: "incoming-call",
                            callId: pending.callId,
                            callerId: pending.callerId,
                            callerName: pending.callerName,
                        }));
                    }
                    catch (e) {
                        console.error("❌ Failed to deliver pending incoming-call:", e);
                    }
                }
                return;
            }
            // pomocné identity
            const currentUserId = ws.userId || null;
            const currentDeviceId = ws.deviceId || null;
            if (!currentUserId || !currentDeviceId)
                return;
            // PING/PONG z FE
            if (type === "ping") {
                try {
                    ws.send(JSON.stringify({ type: "pong" }));
                }
                catch { }
                return;
            }
            if (type === "pong")
                return;
            // CALL REQUEST (client -> admin)
            if (type === "call-request") {
                const targetId = typeof data.targetId === "string" ? data.targetId : undefined;
                const callerName = typeof data.callerName === "string" ? data.callerName : "";
                if (!targetId)
                    return;
                if ((0, config_1.isFridayInBratislava)()) {
                    const minutes = await (0, db_1.fridayMinutes)(currentUserId);
                    if (minutes <= 0) {
                        sendToUser(currentUserId, { type: "insufficient-friday-tokens" }, currentDeviceId);
                        return;
                    }
                }
                const callId = (0, crypto_1.randomUUID)();
                pendingCalls.set(targetId, {
                    callId,
                    callerId: currentUserId,
                    callerName,
                    ts: Date.now(),
                });
                // založ kontext hovoru (poznáme callerDeviceId)
                callCtxById.set(callId, {
                    callId,
                    callerId: currentUserId,
                    calleeId: targetId,
                    callerDeviceId: currentDeviceId,
                });
                // notify admina na všetky zariadenia
                sendToUser(targetId, {
                    type: "incoming-call",
                    callId,
                    callerId: currentUserId,
                    callerName,
                });
                // push
                try {
                    await sendPushToAllUserDevices(targetId, {
                        notification: { title: "Prichádzajúci hovor", body: `${callerName} ti volá` },
                        data: { type: "incoming_call", callId, callerId: currentUserId, callerName },
                    });
                    console.log(`📩 Push sent to ALL devices of ${targetId}`);
                }
                catch (e) {
                    console.error("❌ FCM send error:", e);
                }
                return;
            }
            // SIGNALING (adresne podľa call kontextu)
            if (type === "webrtc-offer" ||
                type === "webrtc-answer" ||
                type === "webrtc-candidate" ||
                type === "request-offer") {
                const targetId = typeof data.targetId === "string" ? data.targetId : undefined;
                let callId = typeof data.callId === "string" ? data.callId : undefined;
                if (!targetId)
                    return;
                // --- 1) Doplň callId, keď chýba (typicky prvý OFFER ide bez callId z FE) ---
                if (!callId) {
                    // pokus č.1: pendingCalls pre tohto callee (admina)
                    const pending = pendingCalls.get(targetId);
                    if (pending && pending.callerId === currentUserId) {
                        callId = pending.callId;
                    }
                    else {
                        // pokus č.2: nájdi existujúci callCtx podľa dvojice (caller, callee)
                        for (const ctx of callCtxById.values()) {
                            if ((ctx.callerId === currentUserId && ctx.calleeId === targetId) ||
                                (ctx.calleeId === currentUserId && ctx.callerId === targetId)) {
                                callId = ctx.callId;
                                break;
                            }
                        }
                    }
                }
                let targetDeviceId;
                if (callId) {
                    let ctx = callCtxById.get(callId);
                    // ak kontext neexistuje (reštart tabu), založ best-effort
                    if (!ctx) {
                        ctx = { callId, callerId: currentUserId, calleeId: targetId };
                        callCtxById.set(callId, ctx);
                    }
                    // zafixuj device od odosielateľa do kontextu
                    if (currentUserId === ctx.callerId)
                        ctx.callerDeviceId = currentDeviceId;
                    if (currentUserId === ctx.calleeId)
                        ctx.calleeDeviceId = ctx.calleeDeviceId ?? currentDeviceId;
                    // ANSWER → lock na admin zariadenie + billing štart
                    if (type === "webrtc-answer") {
                        if (currentUserId === ctx.calleeId) {
                            ctx.calleeDeviceId = currentDeviceId; // LOCK na toto zariadenie
                            pendingCalls.delete(ctx.calleeId);
                            sendToUserExceptDevice(ctx.calleeId, currentDeviceId, {
                                type: "call-locked",
                                callId,
                                by: ctx.calleeId,
                            });
                        }
                        const key = callKeyFor(ctx.callerId, ctx.calleeId);
                        if (!activeCalls.has(key)) {
                            try {
                                await ensureUser(ctx.callerId);
                                await ensureUser(ctx.calleeId);
                                const session = await prisma.callSession.create({
                                    data: { callerId: ctx.callerId, calleeId: ctx.calleeId, status: "active", startedAt: new Date() },
                                });
                                const intervalId = setInterval(async () => {
                                    try {
                                        if ((0, config_1.isFridayInBratislava)()) {
                                            const deficit = await (0, db_1.consumeFridaySeconds)(ctx.callerId, 10);
                                            const minutesLeft = await (0, db_1.fridayMinutes)(ctx.callerId);
                                            sendToUser(ctx.callerId, { type: "friday-balance-update", minutesRemaining: minutesLeft }, ctx.callerDeviceId);
                                            if (deficit > 0 || minutesLeft <= 0) {
                                                const msg = { type: "end-call", reason: "no-friday-tokens" };
                                                sendToUser(ctx.callerId, msg, ctx.callerDeviceId);
                                                sendToUser(ctx.calleeId, msg, ctx.calleeDeviceId);
                                                const endedAt = new Date();
                                                const secondsBilled = Math.ceil((endedAt.getTime() - session.startedAt.getTime()) / 1000);
                                                const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
                                                await prisma.callSession.update({
                                                    where: { id: session.id },
                                                    data: { endedAt, status: "no_tokens", secondsBilled, priceEur },
                                                });
                                                clearInterval(intervalId);
                                                activeCalls.delete(key);
                                            }
                                        }
                                    }
                                    catch (e) {
                                        console.error("decrement/billing interval error:", e);
                                    }
                                }, 10000);
                                activeCalls.set(key, {
                                    callerId: ctx.callerId,
                                    calleeId: ctx.calleeId,
                                    intervalId,
                                    startedAt: session.startedAt,
                                    callSessionId: session.id,
                                });
                                sendToUser(ctx.callerId, { type: "call-started", from: ctx.calleeId, callId }, ctx.callerDeviceId);
                                sendToUser(ctx.calleeId, { type: "call-started", from: ctx.callerId, callId }, ctx.calleeDeviceId);
                            }
                            catch (e) {
                                console.error("callSession start error:", e);
                            }
                        }
                    }
                    // adresný target podľa kontextu
                    if (targetId === ctx.callerId && ctx.callerDeviceId)
                        targetDeviceId = ctx.callerDeviceId;
                    if (targetId === ctx.calleeId && ctx.calleeDeviceId)
                        targetDeviceId = ctx.calleeDeviceId;
                }
                // --- 2) forwarduj a DOPOŠLI aj callId (aby ho FE vždy dostal) ---
                const forwarded = { ...data, from: currentUserId, targetDeviceId, callId };
                console.log("[FW] type=%s from=%s(dev:%s) -> to=%s dev=%s callId=%s", type, currentUserId, currentDeviceId, data.targetId || "-", targetDeviceId || "(any)", forwarded.callId || "-");
                sendToUser(data.targetId, forwarded, targetDeviceId);
                return;
            }
            // END-CALL
            if (type === "end-call") {
                const targetId = typeof data.targetId === "string" ? data.targetId : "";
                const callId = typeof data.callId === "string" ? data.callId : undefined;
                let targetDeviceId;
                let selfDeviceId = currentDeviceId;
                if (callId) {
                    const ctx = callCtxById.get(callId);
                    if (ctx) {
                        if (targetId === ctx.callerId)
                            targetDeviceId = ctx.callerDeviceId;
                        if (targetId === ctx.calleeId)
                            targetDeviceId = ctx.calleeDeviceId;
                    }
                }
                sendToUser(targetId, { type: "end-call", from: currentUserId, callId }, targetDeviceId);
                sendToUser(currentUserId, { type: "end-call", from: targetId, callId }, selfDeviceId);
                // billing finish
                const key = callKeyFor(currentUserId, targetId);
                const c = activeCalls.get(key);
                if (c) {
                    clearInterval(c.intervalId);
                    activeCalls.delete(key);
                    try {
                        const endedAt = new Date();
                        const secondsBilled = Math.ceil((endedAt.getTime() - c.startedAt.getTime()) / 1000);
                        const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
                        await prisma.callSession.update({
                            where: { id: c.callSessionId },
                            data: { endedAt, status: "ended", secondsBilled, priceEur },
                        });
                    }
                    catch (e) {
                        console.error("finish callSession error:", e);
                    }
                }
                return;
            }
        }
        catch (err) {
            console.error("❌ WS message error:", err);
        }
    });
    ws.on("close", () => {
        const userId = ws.userId || null;
        const deviceId = ws.deviceId || null;
        if (userId && deviceId) {
            const map = clients.get(userId);
            if (map) {
                map.delete(deviceId);
                if (map.size === 0)
                    clients.delete(userId);
            }
            console.log(`🔌 WS close user=${userId} device=${deviceId} (left: ${clients.get(userId)?.size || 0})`);
        }
        // keď user nemá žiadne WS, ukonči aktívne hovory tohto usera
        if (userId && !clients.get(userId)) {
            for (const [key, c] of activeCalls.entries()) {
                if (c.callerId === userId || c.calleeId === userId) {
                    clearInterval(c.intervalId);
                    activeCalls.delete(key);
                    (async () => {
                        try {
                            const endedAt = new Date();
                            const secondsBilled = Math.ceil((endedAt.getTime() - c.startedAt.getTime()) / 1000);
                            const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
                            await prisma.callSession.update({
                                where: { id: c.callSessionId },
                                data: { endedAt, status: "aborted", secondsBilled, priceEur },
                            });
                        }
                        catch (e) {
                            console.error("abort callSession error:", e);
                        }
                    })();
                }
            }
        }
    });
    ws.on("error", (e) => {
        const err = e;
        console.error("❌ WS error:", err?.message || e);
    });
});
// WS keepalive
const interval = setInterval(() => {
    wss.clients.forEach((raw) => {
        const ws = raw;
        if (ws.isAlive === false)
            return ws.terminate();
        ws.isAlive = false;
        try {
            ws.ping(() => { });
        }
        catch { }
    });
}, 30000);
// graceful shutdown
process.on("SIGINT", async () => {
    clearInterval(interval);
    wss.clients.forEach((c) => c.terminate());
    server.close();
    await prisma.$disconnect();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    clearInterval(interval);
    wss.clients.forEach((c) => c.terminate());
    server.close();
    await prisma.$disconnect();
    process.exit(0);
});
// ensure admin (ak používaš ADMIN_ID)
(async () => {
    const ADMIN_ID = process.env.ADMIN_ID;
    if (ADMIN_ID) {
        try {
            await ensureUser(ADMIN_ID);
        }
        catch (e) {
            console.error("ensure admin error:", e);
        }
    }
})();
const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
