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
// server.ts
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const ws_1 = __importStar(require("ws"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const firebase_admin_1 = __importDefault(require("./firebase-admin"));
const client_1 = require("@prisma/client");
// Friday modules (TS verzie)
const routes_1 = __importDefault(require("./friday/routes"));
const config_1 = require("./friday/config");
const db_1 = require("./friday/db");
const prisma = new client_1.PrismaClient();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// CORS
const allowedOrigins = [
    "https://frontendtokeny.vercel.app",
    "https://frontendtokeny-42hveafvm-andrejcernaks-projects.vercel.app",
    "http://localhost:3000",
];
app.use((0, cors_1.default)({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin))
            callback(null, true);
        else
            callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
// ====== NOVÉ: Admin helpers (env + validácie) ===============================
const ADMIN_ID = process.env.ADMIN_ID || "";
function assertAdmin(adminId) {
    if (!adminId || adminId !== ADMIN_ID) {
        const e = new Error("Not authorized");
        e.status = 403;
        throw e;
    }
}
function parsePositiveInt(value, field) {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        const e = new Error(`${field} musí byť celé číslo > 0.`);
        e.status = 400;
        throw e;
    }
    return n;
}
function parsePrice(value, field = "priceEur") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        const e = new Error(`${field} musí byť číslo > 0.`);
        e.status = 400;
        throw e;
    }
    return Math.round(n * 100) / 100;
}
const clients = new Map();
const pendingCalls = new Map();
const PENDING_TTL_MS = 90 * 1000;
const activeCalls = new Map();
const PRICE_PER_SECOND = 0.125;
function callKeyFor(a, b) {
    return [a, b].sort().join("__");
}
async function ensureUser(userId) {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}
// REST: push token persist
app.post("/register-fcm", async (req, res) => {
    const body = (req.body || {});
    const { userId, fcmToken, role, platform } = body;
    if (!userId || !fcmToken)
        return res.status(400).json({ error: "Missing userId or fcmToken" });
    try {
        // pamäť (live WS routing)
        if (!clients.has(userId))
            clients.set(userId, { ws: null, fcmToken, role });
        else {
            const entry = clients.get(userId);
            entry.fcmToken = fcmToken;
            if (role)
                entry.role = role;
        }
        // DB persist (PushToken model)
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
// Friday routes mount (tvoje existujúce endpointy ostávajú)
app.use("/", (0, routes_1.default)(prisma));
/**
 * ====== NOVÉ ADMIN ENDPOINTY pre piatkové tokeny ============================
 * - /friday/admin/mint
 * - /friday/admin/update-price
 *
 * Poznámka k schéme (podľa tvojho schema.prisma):
 *  - Individuálne tokeny sú v `FridayToken` (ownerId je voliteľné).
 *  - Emisie/rok sleduje `FridaySupply` (fields: year, totalMinted, totalSold, priceEur).
 *  - „Nepredané“ = FridayToken s ownerId = null a status = active.
 */
// POST /friday/admin/mint { adminId, year, quantity, priceEur }
app.post("/friday/admin/mint", async (req, res) => {
    try {
        const { adminId, year, quantity, priceEur } = (req.body || {});
        assertAdmin(adminId);
        const y = parsePositiveInt(year, "year");
        const qty = parsePositiveInt(quantity, "quantity");
        const price = parsePrice(priceEur, "priceEur");
        // 1) Upsert FridaySupply: navýšime totalMinted a nastavíme „primárnu“ cenu
        await prisma.fridaySupply.upsert({
            where: { year: y },
            update: {
                totalMinted: { increment: qty },
                priceEur: price, // primárna cena pre pokladnicu v danom roku
            },
            create: {
                year: y,
                totalMinted: qty,
                totalSold: 0,
                priceEur: price,
            },
        });
        // 2) Vytvoríme `qty` kusov FridayToken v pokladnici (bez ownera)
        //    createMany preferuje dáta ako plain values; Decimal ako number/string je OK.
        const data = Array.from({ length: qty }, () => ({
            issuedYear: y,
            ownerId: null,
            minutesRemaining: 60,
            status: "active",
            originalPriceEur: price,
        }));
        const result = await prisma.fridayToken.createMany({ data });
        return res.json({
            success: true,
            minted: result.count,
            year: y,
            priceEur: price,
            message: `Vygenerovaných ${result.count} tokenov pre ${y} s cenou ${price} €/ks.`,
        });
    }
    catch (e) {
        console.error("admin/mint error:", e);
        return res.status(e.status ?? 500).json({ success: false, message: e.message ?? "Mint failed" });
    }
});
// POST /friday/admin/update-price { adminId, year, newPriceEur }
app.post("/friday/admin/update-price", async (req, res) => {
    try {
        const { adminId, year, newPriceEur } = (req.body || {});
        assertAdmin(adminId);
        const y = parsePositiveInt(year, "year");
        const newPrice = parsePrice(newPriceEur, "newPriceEur");
        // 1) overíme existenciu supply (ak neexistuje, vytvoríme – ľahký guard)
        await prisma.fridaySupply.upsert({
            where: { year: y },
            update: { priceEur: newPrice },
            create: { year: y, totalMinted: 0, totalSold: 0, priceEur: newPrice },
        });
        // 2) prepíšeme cenu všetkých nepredaných aktívnych tokenov daného roka
        const upd = await prisma.fridayToken.updateMany({
            where: { ownerId: null, status: "active", issuedYear: y },
            data: { originalPriceEur: newPrice },
        });
        return res.json({
            success: true,
            year: y,
            updatedUnsold: upd.count,
            priceEur: newPrice,
            message: `Cena pre rok ${y} nastavená na ${newPrice} € (upravených ${upd.count} nepredaných tokenov).`,
        });
    }
    catch (e) {
        console.error("admin/update-price error:", e);
        return res.status(e.status ?? 500).json({ success: false, message: e.message ?? "Update price failed" });
    }
});
// WebSocket
wss.on("connection", (ws) => {
    let currentUserId = null;
    // keepalive
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message.toString());
            // registrácia
            if (data.type === "register") {
                currentUserId = data.userId || null;
                if (!currentUserId)
                    return;
                const r = data.role || clients.get(currentUserId)?.role;
                if (!clients.has(currentUserId)) {
                    clients.set(currentUserId, { ws, role: r });
                }
                else {
                    const entry = clients.get(currentUserId);
                    entry.ws = ws;
                    if (r)
                        entry.role = r;
                }
                console.log(`✅ ${currentUserId} (${r || "unknown"}) connected via WS`);
                // pending prichádzajúci hovor
                const pending = pendingCalls.get(currentUserId);
                if (pending && Date.now() - pending.ts <= PENDING_TTL_MS) {
                    try {
                        ws.send(JSON.stringify({
                            type: "incoming-call",
                            callerId: pending.callerId,
                            callerName: pending.callerName,
                        }));
                        pendingCalls.delete(currentUserId);
                    }
                    catch (e) {
                        console.error("❌ Failed to deliver pending incoming-call:", e);
                    }
                }
            }
            // klient žiada hovor s adminom
            if (data.type === "call-request") {
                const targetId = data.targetId;
                const callerName = data.callerName || "";
                if (!currentUserId || !targetId)
                    return;
                if ((0, config_1.isFridayInBratislava)()) {
                    const minutes = await (0, db_1.fridayMinutes)(currentUserId);
                    if (minutes <= 0) {
                        const caller = clients.get(currentUserId);
                        if (caller?.ws && caller.ws.readyState === ws_1.default.OPEN) {
                            caller.ws.send(JSON.stringify({ type: "insufficient-friday-tokens" }));
                        }
                        return;
                    }
                }
                console.log(`📞 Call request from ${currentUserId} to ${targetId}`);
                const target = clients.get(targetId);
                // uložiť pending call
                pendingCalls.set(targetId, { callerId: currentUserId, callerName, ts: Date.now() });
                // WS notifikácia adminovi
                if (target?.ws && target.ws.readyState === ws_1.default.OPEN) {
                    try {
                        target.ws.send(JSON.stringify({ type: "incoming-call", callerId: currentUserId, callerName }));
                    }
                    catch (e) {
                        console.error("❌ WS send incoming-call error:", e);
                    }
                }
                // FCM notifikácia (fallback z DB)
                try {
                    let targetToken = target?.fcmToken ?? null;
                    if (!targetToken) {
                        const dbTok = await prisma.pushToken.findFirst({
                            where: { userId: targetId },
                            orderBy: { updatedAt: "desc" },
                        });
                        targetToken = dbTok?.token || null;
                    }
                    if (targetToken) {
                        await firebase_admin_1.default.messaging().send({
                            token: targetToken,
                            notification: { title: "Prichádzajúci hovor", body: `${callerName} ti volá` },
                            data: { type: "incoming_call", callerId: currentUserId, callerName },
                        });
                        console.log(`📩 Push notification sent to ${targetId}`);
                    }
                }
                catch (e) {
                    console.error("❌ FCM send error:", e);
                }
            }
            // WebRTC forward + billing štart pri answeri
            if (["webrtc-offer", "webrtc-answer", "webrtc-candidate", "request-offer"].includes(data.type)) {
                if (!currentUserId || !data.targetId)
                    return;
                const target = clients.get(data.targetId);
                if (target?.ws && target.ws.readyState === ws_1.default.OPEN) {
                    try {
                        const payload = { ...data, from: currentUserId };
                        target.ws.send(JSON.stringify(payload));
                    }
                    catch (e) {
                        console.error(`❌ WS forward ${data.type} error:`, e);
                    }
                }
                // ANSWER → začni billing len v piatok
                if (data.type === "webrtc-answer") {
                    const callerId = data.targetId;
                    const calleeId = currentUserId;
                    const key = callKeyFor(callerId, calleeId);
                    if (!activeCalls.has(key)) {
                        try {
                            await ensureUser(callerId);
                            await ensureUser(calleeId);
                            const session = await prisma.callSession.create({
                                data: { callerId, calleeId, status: "active", startedAt: new Date() },
                            });
                            const intervalId = setInterval(async () => {
                                try {
                                    if ((0, config_1.isFridayInBratislava)()) {
                                        const deficit = await (0, db_1.consumeFridaySeconds)(callerId, 10);
                                        const minutesLeft = await (0, db_1.fridayMinutes)(callerId);
                                        const caller = clients.get(callerId);
                                        if (caller?.ws && caller.ws.readyState === ws_1.default.OPEN) {
                                            caller.ws.send(JSON.stringify({ type: "friday-balance-update", minutesRemaining: minutesLeft }));
                                        }
                                        if (deficit > 0 || minutesLeft <= 0) {
                                            const msg = JSON.stringify({ type: "end-call", reason: "no-friday-tokens" });
                                            const callee = clients.get(calleeId);
                                            try {
                                                caller?.ws && caller.ws.readyState === ws_1.default.OPEN && caller.ws.send(msg);
                                            }
                                            catch { }
                                            try {
                                                callee?.ws && callee.ws.readyState === ws_1.default.OPEN && callee.ws.send(msg);
                                            }
                                            catch { }
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
                                    // mimo piatku: nič neúčtujeme
                                }
                                catch (e) {
                                    console.error("decrement/billing interval error:", e);
                                }
                            }, 10000);
                            activeCalls.set(key, {
                                callerId,
                                calleeId,
                                intervalId,
                                startedAt: session.startedAt,
                                callSessionId: session.id,
                            });
                            const callerEntry = clients.get(callerId);
                            if (callerEntry?.ws && callerEntry.ws.readyState === ws_1.default.OPEN) {
                                callerEntry.ws.send(JSON.stringify({ type: "call-started", from: calleeId }));
                            }
                        }
                        catch (e) {
                            console.error("callSession start error:", e);
                        }
                    }
                }
            }
            // manuálne ukončenie hovoru
            if (data.type === "end-call") {
                const target = clients.get(data.targetId);
                if (target?.ws && target.ws.readyState === ws_1.default.OPEN) {
                    try {
                        target.ws.send(JSON.stringify({ type: "end-call", from: currentUserId }));
                    }
                    catch (e) {
                        console.error("❌ WS end-call forward error:", e);
                    }
                }
                if (currentUserId) {
                    const key = callKeyFor(currentUserId, data.targetId);
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
                }
            }
        }
        catch (err) {
            console.error("❌ WS message error:", err);
        }
    });
    ws.on("close", () => {
        if (currentUserId) {
            for (const [key, c] of activeCalls.entries()) {
                if (c.callerId === currentUserId || c.calleeId === currentUserId) {
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
        if (currentUserId && clients.has(currentUserId)) {
            const entry = clients.get(currentUserId);
            if (entry)
                entry.ws = null;
            console.log(`🔌 ${currentUserId} disconnected`);
        }
    });
    ws.on("error", (e) => {
        console.error("❌ WS error:", e?.message || e);
    });
});
// WS keepalive
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
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
    await prisma.$disconnect();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    await prisma.$disconnect();
    process.exit(0);
});
const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
