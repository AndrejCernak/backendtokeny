require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
const admin = require("./firebase-admin");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const app = express();
app.use(express.json());

// ✅ CORS – doplň svoje produkčné domény podľa potreby
const allowedOrigins = [
  "https://frontendtokeny.vercel.app",
  "https://frontendtokeny-42hveafvm-andrejcernaks-projects.vercel.app",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** Map<userId, { ws: WebSocket|null, fcmToken?: string, role?: 'client'|'admin' }> */
const clients = new Map();

/** Pending prichádzajúce hovory. Map<targetId, { callerId, callerName, ts }> */
const pendingCalls = new Map();
const PENDING_TTL_MS = 90 * 1000;

/** Aktívne hovory a účtovanie.
 * Map<callKey, { callerId, calleeId, intervalId, startedAt, callSessionId }>
 */
const activeCalls = new Map();
const callKeyFor = (a, b) => [a, b].sort().join("__");

// Billing: 450 €/h -> 0.125 €/s
const PRICE_PER_SECOND = 0.125;

/* ===== Helpers: DB (Tokeny) ===== */
async function ensureUser(userId, role = "client") {
  await prisma.user.upsert({
    where: { id: userId },
    update: { role },
    create: { id: userId, role },
  });
}

async function getSeconds(userId) {
  const tb = await prisma.tokenBalance.findUnique({ where: { userId } });
  return tb?.secondsRemaining ?? 0;
}

async function setSeconds(userId, seconds) {
  await prisma.tokenBalance.upsert({
    where: { userId },
    update: { secondsRemaining: seconds },
    create: { userId, secondsRemaining: seconds },
  });
  return seconds;
}

async function incrementSeconds(userId, delta) {
  const current = await getSeconds(userId);
  return await setSeconds(userId, Math.max(0, current + delta));
}

async function decrementSeconds(userId, delta) {
  const current = await getSeconds(userId);
  const newVal = Math.max(0, current - delta);
  await setSeconds(userId, newVal);
  await prisma.transaction.create({
    data: {
      userId,
      type: "call_debit",
      amountEur: 0,
      secondsDelta: -delta,
      note: "call_debit_interval",
    },
  });
  return newVal;
}

function secondsForAmount(amountEur) {
  return Math.floor(Number(amountEur) / PRICE_PER_SECOND);
}

/* ===== REST: balance, purchase, me ===== */
app.get("/balance/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    const secondsRemaining = await getSeconds(userId);
    return res.json({ userId, secondsRemaining });
  } catch (e) {
    console.error("GET /balance error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/purchase", async (req, res) => {
  try {
    const { userId, amountEur } = req.body || {};
    if (!userId || !amountEur) return res.status(400).json({ error: "Missing userId or amountEur" });

    const seconds = secondsForAmount(amountEur);
    await ensureUser(userId, "client");
    await incrementSeconds(userId, seconds);
    await prisma.transaction.create({
      data: { userId, type: "purchase", amountEur: Number(amountEur), secondsDelta: seconds, note: "purchase_mvp" },
    });

    const secondsRemaining = await getSeconds(userId);
    return res.json({ success: true, secondsAdded: seconds, secondsRemaining });
  } catch (e) {
    console.error("POST /purchase error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/me/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const role = user?.role || "client";
    const tb = await prisma.tokenBalance.findUnique({ where: { userId } });
    const secondsRemaining = tb?.secondsRemaining ?? 0;

    return res.json({ userId, role, secondsRemaining });
  } catch (e) {
    console.error("/me error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/** Registrácia FCM tokenu + uloženie role */
app.post("/register-fcm", (req, res) => {
  const { userId, fcmToken, role } = req.body || {};
  if (!userId || !fcmToken) {
    return res.status(400).json({ error: "Missing userId or fcmToken" });
  }

  if (!clients.has(userId)) {
    clients.set(userId, { ws: null, fcmToken, role });
  } else {
    const entry = clients.get(userId);
    entry.fcmToken = fcmToken;
    if (role) entry.role = role;
  }

  // persist role (idempotentne)
  (async () => {
    try {
      const dbRole = role === "admin" ? "admin" : "client";
      await ensureUser(userId, dbRole);
    } catch (e) {
      console.error("upsert user role error:", e);
    }
  })();

  return res.json({ success: true });
});

/* ===== WebSocket spojenie ===== */
wss.on("connection", (ws) => {
  let currentUserId = null;

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      // REGISTER
      if (data.type === "register") {
        currentUserId = data.userId;
        if (!currentUserId) return;

        const role = data.role === "admin" ? "admin" : "client";
        await ensureUser(currentUserId, role);

        if (!clients.has(currentUserId)) {
          clients.set(currentUserId, { ws, role });
        } else {
          const entry = clients.get(currentUserId);
          entry.ws = ws;
          entry.role = role;
        }
        console.log(`✅ ${currentUserId} (${role}) connected via WS`);

        // pending incoming-call po opätovnom pripojení
        const pending = pendingCalls.get(currentUserId);
        if (pending && Date.now() - pending.ts <= PENDING_TTL_MS) {
          try {
            ws.send(JSON.stringify({
              type: "incoming-call",
              callerId: pending.callerId,
              callerName: pending.callerName,
            }));
            pendingCalls.delete(currentUserId);
          } catch (e) {
            console.error("❌ Failed to deliver pending incoming-call:", e);
          }
        }
      }

      // CALL REQUEST
      if (data.type === "call-request") {
        const { targetId, callerName } = data;
        if (!currentUserId || !targetId) return;

        const callerEntry = clients.get(currentUserId);
        const callerRole = callerEntry?.role || "client";

        // len klient musí mať kredit
        if (callerRole !== "admin") {
          const seconds = await getSeconds(currentUserId);
          if (seconds <= 0) {
            if (callerEntry?.ws?.readyState === WebSocket.OPEN) {
              callerEntry.ws.send(JSON.stringify({ type: "insufficient-tokens" }));
            }
            return;
          }
        }

        console.log(`📞 Call request from ${currentUserId} to ${targetId}`);
        const target = clients.get(targetId);

        // pending (aj keď cieľ nie je online)
        pendingCalls.set(targetId, { callerId: currentUserId, callerName, ts: Date.now() });

        // WS adminovi
        if (target?.ws?.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: "incoming-call", callerId: currentUserId, callerName }));
          } catch (e) {
            console.error("❌ WS send incoming-call error:", e);
          }
        }

        // FCM push
        if (target?.fcmToken) {
          try {
            await admin.messaging().send({
              token: target.fcmToken,
              notification: { title: "Prichádzajúci hovor", body: `${callerName} ti volá` },
              data: { type: "incoming_call", callerId: currentUserId, callerName: callerName || "" },
            });
            console.log(`📩 Push notification sent to ${targetId}`);
          } catch (e) {
            console.error("❌ FCM send error:", e);
          }
        }
      }

      // WebRTC forward (pridáme 'from')
      if (["webrtc-offer", "webrtc-answer", "webrtc-candidate"].includes(data.type)) {
        if (!currentUserId || !data.targetId) return;

        const target = clients.get(data.targetId);
        if (target?.ws?.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ ...data, from: currentUserId }));
          } catch (e) {
            console.error(`❌ WS forward ${data.type} error:`, e);
          }
        }

        // Spustenie billing-u pri ANSWER (admin -> volajúci)
        if (data.type === "webrtc-answer") {
          const callerId = data.targetId;     // komu posielame answer
          const calleeId = currentUserId;     // kto poslal answer (admin)

          const key = callKeyFor(callerId, calleeId);
          if (!activeCalls.has(key)) {
            try {
              const callerRole = clients.get(callerId)?.role || "client";
              await ensureUser(callerId, callerRole);
              await ensureUser(calleeId, "admin");

              const session = await prisma.callSession.create({
                data: { callerId, calleeId, status: "active", startedAt: new Date() },
              });

              const billCaller = callerRole !== "admin"; // admin sa neúčtuje

              const intervalId = setInterval(async () => {
                try {
                  if (billCaller) {
                    const remaining = await decrementSeconds(callerId, 10);

                    // live update klientovi
                    const caller = clients.get(callerId);
                    if (caller?.ws?.readyState === WebSocket.OPEN) {
                      caller.ws.send(JSON.stringify({ type: "balance-update", secondsRemaining: remaining }));
                    }

                    if (remaining <= 0) {
                      const msg = JSON.stringify({ type: "end-call", reason: "no-tokens" });
                      const callee = clients.get(calleeId);
                      const callerWs = clients.get(callerId)?.ws;
                      try { callerWs?.readyState === WebSocket.OPEN && callerWs.send(msg); } catch {}
                      try { callee?.ws?.readyState === WebSocket.OPEN && callee.ws.send(msg); } catch {}

                      const endedAt = new Date();
                      const secondsBilled = Math.ceil((endedAt - session.startedAt) / 1000);
                      const priceEur = Math.round(secondsBilled * PRICE_PER_SECOND * 100) / 100;
                      await prisma.callSession.update({
                        where: { id: session.id },
                        data: { endedAt, status: "no_tokens", secondsBilled, priceEur },
                      });

                      clearInterval(intervalId);
                      activeCalls.delete(key);
                    }
                  }
                } catch (e) {
                  console.error("billing interval error:", e);
                }
              }, 10_000);

              activeCalls.set(key, {
                callerId,
                calleeId,
                intervalId,
                startedAt: session.startedAt,
                callSessionId: session.id,
              });

              // potvrdenie volajúcemu
              const callerEntry = clients.get(callerId);
              if (callerEntry?.ws?.readyState === WebSocket.OPEN) {
                callerEntry.ws.send(JSON.stringify({ type: "call-started", from: calleeId }));
              }
            } catch (e) {
              console.error("callSession start error:", e);
            }
          }
        }
      }

      // Manuálne ukončenie
      if (data.type === "end-call") {
        const target = clients.get(data.targetId);
        if (target?.ws?.readyState === WebSocket.OPEN) {
          try { target.ws.send(JSON.stringify({ type: "end-call", from: currentUserId })); } catch (e) {
            console.error("❌ WS end-call forward error:", e);
          }
        }

        const key = callKeyFor(currentUserId, data.targetId);
        const c = activeCalls.get(key);
        if (c) {
          clearInterval(c.intervalId);
          activeCalls.delete(key);
          try {
            const endedAt = new Date();
            const secondsBilled = Math.ceil((endedAt - c.startedAt) / 1000);
            const priceEur = Math.round(secondsBilled * PRICE_PER_SECOND * 100) / 100;
            await prisma.callSession.update({
              where: { id: c.callSessionId },
              data: { endedAt, status: "ended", secondsBilled, priceEur },
            });
          } catch (e) {
            console.error("finish callSession error:", e);
          }
        }
      }
    } catch (err) {
      console.error("❌ WS message error:", err);
    }
  });

  ws.on("close", () => {
    if (currentUserId) {
      // stopni meter ak user spadne
      for (const [key, c] of activeCalls.entries()) {
        if (c.callerId === currentUserId || c.calleeId === currentUserId) {
          clearInterval(c.intervalId);
          activeCalls.delete(key);
          (async () => {
            try {
              const endedAt = new Date();
              const secondsBilled = Math.ceil((endedAt - c.startedAt) / 1000);
              const priceEur = Math.round(secondsBilled * PRICE_PER_SECOND * 100) / 100;
              await prisma.callSession.update({
                where: { id: c.callSessionId },
                data: { endedAt, status: "aborted", secondsBilled, priceEur },
              });
            } catch (e) {
              console.error("abort callSession error:", e);
            }
          })();
        }
      }
    }

    if (currentUserId && clients.has(currentUserId)) {
      const entry = clients.get(currentUserId);
      if (entry) entry.ws = null;
      console.log(`🔌 ${currentUserId} disconnected`);
    }
  });

  ws.on("error", (e) => console.error("❌ WS error:", e?.message || e));
});

// WS keepalive
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(() => {}); } catch {}
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

// Graceful shutdown
process.on("SIGINT", async () => { await prisma.$disconnect(); process.exit(0); });
process.on("SIGTERM", async () => { await prisma.$disconnect(); process.exit(0); });

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
