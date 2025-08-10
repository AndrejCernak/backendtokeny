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

// ✅ Povolené originy pre CORS
const allowedOrigins = [
  "https://frontendtokeny.vercel.app", // hlavná Vercel URL
  "https://frontendtokeny-42hveafvm-andrejcernaks-projects.vercel.app", // preview URL
  "http://localhost:3000", // lokálny vývoj
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Uložíme pripojených užívateľov:
 * Map<userId, { ws: WebSocket|null, fcmToken?: string, role?: 'client'|'admin' }>
 */
const clients = new Map();

/**
 * Pending prichádzajúce hovory: keď app nie je otvorená, WS nebeží.
 * Pošleme "incoming-call" hneď po REGISTER, ak je tu čerstvý záznam.
 * Map<targetId, { callerId: string, callerName: string, ts: number }>
 */
const pendingCalls = new Map();
const PENDING_TTL_MS = 90 * 1000; // držíme 90 sekúnd

/**
 * Aktívne hovory a účtovanie
 * Map<callKey, { callerId, calleeId, intervalId, startedAt, callSessionId }>
 */
const activeCalls = new Map();
function callKeyFor(a, b) {
  return [a, b].sort().join("__");
}

// Billing: 450 €/h -> 0.125 €/s
const PRICE_PER_SECOND = 0.125;

// ===== Helpers: DB (Tokeny) =====
async function ensureUser(userId) {
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
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

// ===== REST: balance & purchase (MVP) =====
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

    await ensureUser(userId);
    const seconds = secondsForAmount(amountEur);

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

/** 
 * API endpoint na registráciu FCM tokenu po prihlásení 
 */
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

  return res.json({ success: true });
});

// ===== WebSocket spojenie =====
wss.on("connection", (ws) => {
  let currentUserId = null;

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      // Registrácia užívateľa na WS
      if (data.type === "register") {
        currentUserId = data.userId;
        if (!currentUserId) return;

        const role = data.role || (clients.get(currentUserId)?.role ?? undefined);

        if (!clients.has(currentUserId)) {
          clients.set(currentUserId, { ws, role });
        } else {
          const entry = clients.get(currentUserId);
          entry.ws = ws;
          if (role) entry.role = role;
        }
        console.log(`✅ ${currentUserId} (${role || "unknown"}) connected via WS`);

        // Ak má tento user pending prichádzajúci hovor, hneď mu ho odošli
        const pending = pendingCalls.get(currentUserId);
        if (pending && Date.now() - pending.ts <= PENDING_TTL_MS) {
          try {
            ws.send(
              JSON.stringify({
                type: "incoming-call",
                callerId: pending.callerId,
                callerName: pending.callerName,
              })
            );
            pendingCalls.delete(currentUserId);
          } catch (e) {
            console.error("❌ Failed to deliver pending incoming-call:", e);
          }
        }
      }

      // Klient zavolá adminovi
      if (data.type === "call-request") {
        const { targetId, callerName } = data;
        if (!currentUserId || !targetId) return;

        // ❗ over zostatok volajúceho
        const seconds = await getSeconds(currentUserId);
        if (seconds <= 0) {
          const caller = clients.get(currentUserId);
          if (caller?.ws?.readyState === WebSocket.OPEN) {
            caller.ws.send(JSON.stringify({ type: "insufficient-tokens" }));
          }
          return;
        }

        console.log(`📞 Call request from ${currentUserId} to ${targetId}`);
        const target = clients.get(targetId);

        // Ulož pending call (aj keby cieľ nebol online)
        pendingCalls.set(targetId, {
          callerId: currentUserId,
          callerName,
          ts: Date.now(),
        });

        // Poslať WS event adminovi (ak je online)
        if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(
              JSON.stringify({
                type: "incoming-call",
                callerId: currentUserId,
                callerName,
              })
            );
          } catch (e) {
            console.error("❌ WS send incoming-call error:", e);
          }
        }

        // Poslať FCM notifikáciu (ak máme token)
        if (target?.fcmToken) {
          try {
            await admin.messaging().send({
              token: target.fcmToken,
              notification: {
                title: "Prichádzajúci hovor",
                body: `${callerName} ti volá`,
              },
              data: {
                type: "incoming_call",
                callerId: currentUserId,
                callerName: callerName || "",
              },
            });
            console.log(`📩 Push notification sent to ${targetId}`);
          } catch (e) {
            console.error("❌ FCM send error:", e);
          }
        }
      }

      // WebRTC forwardovanie správ (pridávame aj 'from')
      if (["webrtc-offer", "webrtc-answer", "webrtc-candidate"].includes(data.type)) {
        if (!currentUserId || !data.targetId) return;

        console.log(`🔁 Forwarding ${data.type} from ${currentUserId} to ${data.targetId}`);
        const target = clients.get(data.targetId);

        if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
          try {
            const payload = { ...data, from: currentUserId };
            target.ws.send(JSON.stringify(payload));
          } catch (e) {
            console.error(`❌ WS forward ${data.type} error:`, e);
          }
        }

        // 🔔 Keď admin pošle ANSWER volajúcemu, spustíme billing
        if (data.type === "webrtc-answer") {
          const callerId = data.targetId; // komu answer posielame
          const calleeId = currentUserId; // kto answer poslal (admin)

          // založ CallSession (ak ešte neexistuje)
          const key = callKeyFor(callerId, calleeId);
          if (!activeCalls.has(key)) {
            try {
              await ensureUser(callerId);
              await ensureUser(calleeId);

              const session = await prisma.callSession.create({
                data: {
                  callerId,
                  calleeId,
                  status: "active",
                  startedAt: new Date(),
                },
              });

              // každých 10 s odpočítaj 10 s volajúcemu
              const intervalId = setInterval(async () => {
                try {
                  const remaining = await decrementSeconds(callerId, 10);

                  // voliteľné: posielaj live balance-update
                  const caller = clients.get(callerId);
                  if (caller?.ws?.readyState === WebSocket.OPEN) {
                    caller.ws.send(
                      JSON.stringify({
                        type: "balance-update",
                        secondsRemaining: remaining,
                      })
                    );
                  }

                  if (remaining <= 0) {
                    // došlo – ukonči hovor
                    const msg = JSON.stringify({ type: "end-call", reason: "no-tokens" });
                    const callee = clients.get(calleeId);
                    try { caller?.ws?.readyState === WebSocket.OPEN && caller.ws.send(msg); } catch {}
                    try { callee?.ws?.readyState === WebSocket.OPEN && callee.ws.send(msg); } catch {}

                    // ukonči session
                    const endedAt = new Date();
                    const secondsBilled = Math.ceil((endedAt - session.startedAt) / 1000);
                    const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
                    await prisma.callSession.update({
                      where: { id: session.id },
                      data: {
                        endedAt,
                        status: "no_tokens",
                        secondsBilled,
                        priceEur,
                      },
                    });

                    clearInterval(intervalId);
                    activeCalls.delete(key);
                  }
                } catch (e) {
                  console.error("decrement/billing interval error:", e);
                }
              }, 10_000);

              activeCalls.set(key, {
                callerId,
                calleeId,
                intervalId,
                startedAt: session.startedAt,
                callSessionId: session.id,
              });

              // pošli volajúcemu info, že hovor naozaj začal
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

      // Ukončenie hovoru (manuálne)
      if (data.type === "end-call") {
        const target = clients.get(data.targetId);
        if (target?.ws?.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: "end-call", from: currentUserId }));
          } catch (e) {
            console.error("❌ WS end-call forward error:", e);
          }
        }

        // zastav meter pre túto dvojicu a ulož CallSession
        const key = callKeyFor(currentUserId, data.targetId);
        const c = activeCalls.get(key);
        if (c) {
          clearInterval(c.intervalId);
          activeCalls.delete(key);
          try {
            const endedAt = new Date();
            const secondsBilled = Math.ceil((endedAt - c.startedAt) / 1000);
            const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
            await prisma.callSession.update({
              where: { id: c.callSessionId },
              data: {
                endedAt,
                status: "ended",
                secondsBilled,
                priceEur,
              },
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
    // ak ktokoľvek z dvojice spadne, stopni meter
    if (currentUserId) {
      for (const [key, c] of activeCalls.entries()) {
        if (c.callerId === currentUserId || c.calleeId === currentUserId) {
          clearInterval(c.intervalId);
          activeCalls.delete(key);
          // ukončiť aj CallSession ako 'aborted'
          (async () => {
            try {
              const endedAt = new Date();
              const secondsBilled = Math.ceil((endedAt - c.startedAt) / 1000);
              const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
              await prisma.callSession.update({
                where: { id: c.callSessionId },
                data: {
                  endedAt,
                  status: "aborted",
                  secondsBilled,
                  priceEur,
                },
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
      if (entry) entry.ws = null; // necháme fcmToken/role, user sa môže vrátiť
      console.log(`🔌 ${currentUserId} disconnected`);
    }
  });

  ws.on("error", (e) => {
    console.error("❌ WS error:", e?.message || e);
  });
});

// WS keepalive (pomôže na niektorých hostoch)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping(() => {});
    } catch {}
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

// Graceful shutdown Prisma
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
