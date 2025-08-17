// backend/server.ts
import "dotenv/config";
import express from "express";
import WebSocket, { WebSocketServer, RawData } from "ws";
import http from "http";
import cors from "cors";
import admin from "./firebase-admin";
import { PrismaClient } from "@prisma/client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomUUID } from "crypto";

// ───────────────────────────────────────────────────────────────────────────────
// Rozšírenie typu pre ws (keepalive)
declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}

// Friday moduly
import fridayRoutes from "./friday/routes";
import { isFridayInBratislava } from "./friday/config";
import { fridayMinutes, consumeFridaySeconds } from "./friday/db";

// ───────────────────────────────────────────────────────────────────────────────
// Inicializácie
const prisma = new PrismaClient();
const app = express();
app.use(express.json());

// CORS (vrátane vercel preview domén)
const allowedOrigins = new Set<string>([
  "https://frontendtokeny.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      try {
        const url = new URL(origin);
        const ok =
          allowedOrigins.has(origin) ||
          /\.vercel\.app$/.test(url.hostname); // povolí všetky vercel preview
        if (ok) return callback(null, true);
      } catch {}
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// HTTP + WS server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ───────────────────────────────────────────────────────────────────────────────
// Clerk JWT (pre REST). WS registrácia nechávame kompatibilnú s FE (posiela userId).
const ISSUER = process.env.CLERK_ISSUER; // napr. https://your-subdomain.clerk.accounts.dev
if (!ISSUER) console.warn("⚠️  Missing CLERK_ISSUER in env!");
const JWKS = ISSUER
  ? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
  : null;

async function getUserIdFromAuthHeader(req: express.Request): Promise<string | null> {
  try {
    const auth = req.header("authorization") || req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) return null;
    const token = auth.slice("Bearer ".length);
    if (!JWKS || !ISSUER) return null;
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER });
    return (payload.sub as string) || null;
  } catch (e) {
    console.error("JWT verify error:", e);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Pomocné štruktúry pre WS a hovory

type Role = "client" | "admin";

// namiesto jedného socketu na usera -> Set socketov (všetky okná/zariadenia)
const clients = new Map<string, Set<WebSocket>>();

type PendingCall = { callId: string; callerId: string; callerName: string; ts: number };
const PENDING_TTL_MS = 3 * 60 * 1000; // 3 min
const pendingCalls = new Map<string, PendingCall>(); // kľúč: calleeId (admin)

type ActiveCall = {
  callerId: string;
  calleeId: string;
  intervalId: NodeJS.Timeout;
  startedAt: Date;
  callSessionId: string;
};
const activeCalls = new Map<string, ActiveCall>();
const PRICE_PER_SECOND = 0.125;

function callKeyFor(a: string, b: string) {
  return [a, b].sort().join("__");
}

async function ensureUser(userId: string) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}

// WS broadcast helpery
function sendToUser(userId: string, msg: any) {
  const set = clients.get(userId);
  if (!set) return;
  const json = JSON.stringify(msg);
  for (const sock of set) {
    if (sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(json);
      } catch {}
    }
  }
}

function sendToUserExcept(userId: string, except: WebSocket, msg: any) {
  const set = clients.get(userId);
  if (!set) return;
  const json = JSON.stringify(msg);
  for (const sock of set) {
    if (sock === except) continue;
    if (sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(json);
      } catch {}
    }
  }
}

// FCM: pošli push na všetky zariadenia usera + cleanup zlých tokenov
async function sendPushToAllUserDevices(
  userId: string,
  payload: {
    notification?: admin.messaging.Notification;
    data?: { [key: string]: string };
  }
) {
  const rows = await prisma.pushToken.findMany({ where: { userId } });
  const tokens = rows.map((r) => r.token).filter(Boolean);
  if (!tokens.length) return;

  const resp = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: payload.notification,
    data: payload.data,
  });

  const toDelete: string[] = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
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
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  try {
    await ensureUser(userId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("sync-user error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// 2) Registrácia/aktualizácia FCM tokenu
app.post("/register-fcm", async (req, res) => {
  const userId = await getUserIdFromAuthHeader(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });

  const body = (req.body || {}) as {
    fcmToken?: string;
    role?: Role;
    platform?: string;
  };
  const { fcmToken, platform } = body;
  if (!fcmToken) return res.status(400).json({ error: "Missing fcmToken" });

  try {
    await ensureUser(userId);

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

// 3) Friday routes
app.use("/", fridayRoutes(prisma));

// 4) REST fallback: zisti pending prichádzajúci hovor pre aktuálneho užívateľa (admina)
app.get("/calls/pending", async (req, res) => {
  try {
    const userId = await getUserIdFromAuthHeader(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

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
  } catch (e) {
    console.error("calls/pending error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// WEBSOCKET
wss.on("connection", (ws: WebSocket) => {
  let currentUserId: string | null = null;

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (message: RawData) => {
    try {
      const data = JSON.parse(message.toString()) as any;

      // registrácia klienta do WS mapy (FE posiela {type:"register", userId})
      if (data.type === "register") {
        currentUserId = (data.userId as string) || null;
        if (!currentUserId) return;

        let set = clients.get(currentUserId);
        if (!set) {
          set = new Set<WebSocket>();
          clients.set(currentUserId, set);
        }
        set.add(ws);

        console.log(`✅ ${currentUserId} connected via WS (now ${set.size} socket(s))`);

        // ak bol pending prichádzajúci hovor → doruč "incoming-call" do tohto socketu (nevymazávame hneď)
        const pending = pendingCalls.get(currentUserId);
        if (pending && Date.now() - pending.ts <= PENDING_TTL_MS) {
          try {
            ws.send(
              JSON.stringify({
                type: "incoming-call",
                callId: pending.callId,
                callerId: pending.callerId,
                callerName: pending.callerName,
              })
            );
          } catch (e) {
            console.error("❌ Failed to deliver pending incoming-call:", e);
          }
        }
      }

      // klient žiada hovor s adminom
      if (data.type === "call-request") {
        const targetId = data.targetId as string | undefined;
        const callerName = (data.callerName as string) || "";
        if (!currentUserId || !targetId) return;

        if (isFridayInBratislava()) {
          const minutes = await fridayMinutes(currentUserId);
          if (minutes <= 0) {
            sendToUser(currentUserId, { type: "insufficient-friday-tokens" });
            return;
          }
        }

        console.log(`📞 Call request from ${currentUserId} to ${targetId}`);

        // vygeneruj callId a ulož pending call
        const callId = randomUUID();
        pendingCalls.set(targetId, { callId, callerId: currentUserId, callerName, ts: Date.now() });

        // WS notifikácia adminovi (na všetky otvorené okná/zariadenia)
        sendToUser(targetId, {
          type: "incoming-call",
          callId,
          callerId: currentUserId,
          callerName,
        });

        // FCM notifikácia (na všetky zariadenia admina)
        try {
          await sendPushToAllUserDevices(targetId, {
            notification: { title: "Prichádzajúci hovor", body: `${callerName} ti volá` },
            data: {
              type: "incoming_call",
              callId,
              callerId: currentUserId,
              callerName,
            },
          });
          console.log(`📩 Push notification sent to ALL devices of ${targetId}`);
        } catch (e) {
          console.error("❌ FCM send error:", e);
        }
      }

      // WebRTC forward + billing štart pri answeri
      if (["webrtc-offer", "webrtc-answer", "webrtc-candidate", "request-offer"].includes(data.type)) {
        if (!currentUserId || !data.targetId) return;

        // forward na všetky WS cieľa
        sendToUser(data.targetId as string, { ...data, from: currentUserId });

        // ANSWER → začni billing len v piatok + lock pre ostatné zariadenia admina
        if (data.type === "webrtc-answer") {
          const callerId = data.targetId as string; // komu posielame answer (volajúci)
          const calleeId = currentUserId;          // kto odpovedá (admin)
          const thisCallId = data.callId as string | undefined;

          // po answeri zruš pending pre callee (admina), aby ostatné jeho okná zhasli banner
          const pend = pendingCalls.get(calleeId);
          if (pend && (!thisCallId || thisCallId === pend.callId)) {
            pendingCalls.delete(calleeId);
          }
          // pošli "call-locked" do ostatných WS toho istého admina (s callId kvôli presnosti)
          sendToUserExcept(calleeId, ws, {
            type: "call-locked",
            callId: thisCallId,
            by: calleeId,
          });

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
                  if (isFridayInBratislava()) {
                    const deficit = await consumeFridaySeconds(callerId, 10);
                    const minutesLeft = await fridayMinutes(callerId);

                    sendToUser(callerId, {
                      type: "friday-balance-update",
                      minutesRemaining: minutesLeft,
                    });

                    if (deficit > 0 || minutesLeft <= 0) {
                      const msg = { type: "end-call", reason: "no-friday-tokens" };
                      sendToUser(callerId, msg);
                      sendToUser(calleeId, msg);

                      const endedAt = new Date();
                      const secondsBilled = Math.ceil(
                        (endedAt.getTime() - session.startedAt.getTime()) / 1000
                      );
                      const priceEur = (secondsBilled * PRICE_PER_SECOND).toFixed(2);
                      await prisma.callSession.update({
                        where: { id: session.id },
                        data: { endedAt, status: "no_tokens", secondsBilled, priceEur },
                      });

                      clearInterval(intervalId);
                      activeCalls.delete(key);
                    }
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

              // ⚠️ Dôležité: pošli call-started OBOm stranám (FE sa na to spolieha)
              sendToUser(callerId, { type: "call-started", from: calleeId, callId: thisCallId });
              sendToUser(calleeId, { type: "call-started", from: callerId, callId: thisCallId });
            } catch (e) {
              console.error("callSession start error:", e);
            }
          }
        }
      }

      // manuálne ukončenie hovoru
      if (data.type === "end-call") {
        const targetId = data.targetId as string;
        // echo na druhú stranu + aj späť volajúcemu (všetky jeho WS)
        sendToUser(targetId, { type: "end-call", from: currentUserId, callId: data.callId });
        if (currentUserId) sendToUser(currentUserId, { type: "end-call", from: targetId, callId: data.callId });

        if (currentUserId) {
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
            } catch (e) {
              console.error("finish callSession error:", e);
            }
          }
        }
      }
    } catch (err) {
      console.error("❌ WS message error:", err);
    }
  });

  ws.on("close", () => {
    // odpoj tento socket zo setu usera
    if (currentUserId) {
      const set = clients.get(currentUserId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clients.delete(currentUserId);
      }
      console.log(
        `🔌 ${currentUserId} disconnected (remaining ${clients.get(currentUserId)?.size || 0})`
      );
    }

    // cleanup aktívnych hovorov IBA ak užívateľ už nemá ŽIADNE ďalšie WS
    if (currentUserId && !clients.get(currentUserId)) {
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
            } catch (e) {
              console.error("abort callSession error:", e);
            }
          })();
        }
      }
    }
  });

  ws.on("error", (e: any) => {
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
    } catch (e) {
      console.error("ensure admin error:", e);
    }
  }
})();

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
