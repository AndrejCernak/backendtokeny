require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
const admin = require("./firebase-admin");
const { PrismaClient } = require("@prisma/client");

// Friday modules
const fridayRoutes = require("./friday/routes");
const { isFridayInBratislava } = require("./friday/config");
const { fridayMinutes, consumeFridaySeconds } = require("./friday/db");

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
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// 1 token (starý kredit) = 60 min
const TOKEN_MINUTES = 60;
const SECONDS_PER_TOKEN = TOKEN_MINUTES * 60;

// Cenník balíkov – zachované pre „bežný kredit“ mimo piatkov (môžeš neskôr zrušiť)
function priceForTokens(tokens) {
  switch (tokens) {
    case 1: return 450;
    case 3: return 1280;
    case 5: return 2070;
    case 10: return 3960;
    default: throw new Error("Unsupported token pack");
  }
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Uložíme pripojených užívateľov:
 * Map<userId, { ws: WebSocket|null, fcmToken?: string, role?: 'client'|'admin' }>
 */
const clients = new Map();

/**
 * Pending prichádzajúce hovory (ak app nie je otvorená).
 * Map<targetId, { callerId: string, callerName: string, ts: number }>
 */
const pendingCalls = new Map();
const PENDING_TTL_MS = 90 * 1000;

/**
 * Aktívne hovory a účtovanie
 * Map<callKey, { callerId, calleeId, intervalId, startedAt, callSessionId }>
 */
const activeCalls = new Map();
function callKeyFor(a, b) {
  return [a, b].sort().join("__");
}

// Billing pre „bežný“ kredit: 450 €/h -> 0.125 €/s
const PRICE_PER_SECOND = 0.125;

// ===== Helpers: DB (bežný kredit v sekundách) =====
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

// ===== REST: balance & purchase (MVP bežného kreditu) =====
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

app.post("/purchase-tokens", async (req, res) => {
  try {
    const { userId, tokens } = req.body || {};
    if (!userId || !Number.isInteger(tokens) || tokens <= 0) {
      return res.status(400).json({ success: false, message: "Missing or invalid userId/tokens" });
    }

    await ensureUser(userId);

    let amountEur = 0;
    try {
      amountEur = priceForTokens(tokens);
    } catch (e) {
      return res.status(400).json({ success: false, message: "Unsupported token pack" });
    }

    const secondsToAdd = tokens * SECONDS_PER_TOKEN;

    await incrementSeconds(userId, secondsToAdd);

    await prisma.transaction.create({
      data: {
        userId,
        type: "purchase",
        amountEur: Number(amountEur),
        secondsDelta: secondsToAdd,
        note: `tokens:${tokens}`,
      },
    });

    const secondsRemaining = await getSeconds(userId);

    const entry = clients.get(userId);
    if (entry?.ws?.readyState === WebSocket.OPEN) {
      try {
        entry.ws.send(JSON.stringify({ type: "balance-update", secondsRemaining }));
      } catch {}
    }

    return res.json({
      success: true,
      tokensAdded: tokens,
      secondsAdded: secondsToAdd,
      secondsRemaining,
      amountEur,
    });
  } catch (e) {
    console.error("POST /purchase-tokens error:", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * API endpoint na registráciu FCM tokenu po prihlásení (PERSISTENT)
 */
app.post("/register-fcm", async (req, res) => {
  const { userId, fcmToken, role, platform } = req.body || {};
  if (!userId || !fcmToken) {
    return res.status(400).json({ error: "Missing userId or fcmToken" });
  }

  try {
    // pamäť (live WS routing)
    if (!clients.has(userId)) {
      clients.set(userId, { ws: null, fcmToken, role });
    } else {
      const entry = clients.get(userId);
      entry.fcmToken = fcmToken;
      if (role) entry.role = role;
    }

    // DB persist (vyžaduje Prisma model PushToken)
    await prisma.pushToken.upsert({
      where: { token: fcmToken },
      update: { userId, platform: platform || null },
      create: { userId, token: fcmToken, platform: platform || null },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("register-fcm error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * ===== PIATOK: tokenová ekonomika a burza
 * Mountneme /friday/* routy
 */
app.use("/", fridayRoutes(prisma));

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

        if (isFridayInBratislava()) {
          const minutes = await fridayMinutes(currentUserId);
          if (minutes <= 0) {
            const caller = clients.get(currentUserId);
            if (caller?.ws?.readyState === WebSocket.OPEN) {
              caller.ws.send(JSON.stringify({ type: "insufficient-friday-tokens" }));
            }
            return;
          }
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

        // Poslať FCM notifikáciu (DB fallback)
        try {
          let targetToken = target?.fcmToken;
          if (!targetToken) {
            const dbTok = await prisma.pushToken.findFirst({
              where: { userId: targetId },
              orderBy: { updatedAt: "desc" },
            });
            targetToken = dbTok?.token || null;
          }

          if (targetToken) {
            await admin.messaging().send({
              token: targetToken,
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
          }
        } catch (e) {
          console.error("❌ FCM send error:", e);
        }
      }

      // WebRTC forwardovanie správ (pridávame aj 'from')
        if (["webrtc-offer", "webrtc-answer", "webrtc-candidate", "request-offer"].includes(data.type)) {
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

              // každých 10 s odpočítaj 10 s
              const intervalId = setInterval(async () => {
                try {
                    if (isFridayInBratislava()) {
                      // PIATOK → piatkové tokeny
                      const deficit = await consumeFridaySeconds(callerId, 10);
                      const minutesLeft = await fridayMinutes(callerId);

                      // live update klientovi (minúty)
                      const caller = clients.get(callerId);
                      if (caller?.ws?.readyState === WebSocket.OPEN) {
                        caller.ws.send(JSON.stringify({ type: "friday-balance-update", minutesRemaining: minutesLeft }));
                      }

                      if (deficit > 0 || minutesLeft <= 0) {
                        // došli piatkové minúty – ukonči hovor
                        const msg = JSON.stringify({ type: "end-call", reason: "no-friday-tokens" });
                        const callee = clients.get(calleeId);
                        try { caller?.ws?.readyState === WebSocket.OPEN && caller.ws.send(msg); } catch {}
                        try { callee?.ws?.readyState === WebSocket.OPEN && callee.ws.send(msg); } catch {}

                        const endedAt = new Date();
                        const secondsBilled = Math.ceil((endedAt - session.startedAt) / 1000);
                        const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2); // informatívne
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
                    }
                    // mimo piatku: nič neúčtujeme, necháme hovor bežať

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

              // informuj volajúceho, že hovor naozaj začal
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
    if (currentUserId) {
      for (const [key, c] of activeCalls.entries()) {
        if (c.callerId === currentUserId || c.calleeId === currentUserId) {
          clearInterval(c.intervalId);
          activeCalls.delete(key);
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
      if (entry) entry.ws = null;
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
