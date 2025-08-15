// server.ts
import "dotenv/config";
import express from "express";
import WebSocket, { WebSocketServer, RawData } from "ws";
import http from "http";
import cors from "cors";
import admin from "./firebase-admin";
import { PrismaClient } from "@prisma/client";

// 🔧 rozšírime typ WebSocket o pomocnú vlajku keepalive (isAlive)
declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}



// Friday modules (TS verzie)
import fridayRoutes from "./friday/routes";
import { isFridayInBratislava } from "./friday/config";
import { fridayMinutes, consumeFridaySeconds } from "./friday/db";

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

// CORS
const allowedOrigins = [
  "https://frontendtokeny.vercel.app",
  "http://localhost:3000",
];

app.use(
  cors({
    origin(origin, callback) {
      // povoliť localhost, presnú prod doménu a ľubovoľné *.vercel.app preview
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        /\.vercel\.app$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Mapy spojení
type Role = "client" | "admin";
type ClientEntry = { ws: WebSocket | null; fcmToken?: string | null; role?: Role };
const clients = new Map<string, ClientEntry>();

type PendingCall = { callerId: string; callerName: string; ts: number };
const pendingCalls = new Map<string, PendingCall>();
const PENDING_TTL_MS = 90 * 1000;

// aktívne hovory
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

// REST: push token persist
app.post("/register-fcm", async (req, res) => {
  const body = (req.body || {}) as {
    userId?: string;
    fcmToken?: string;
    role?: Role;
    platform?: string;
  };
  const { userId, fcmToken, role, platform } = body;
  if (!userId || !fcmToken) return res.status(400).json({ error: "Missing userId or fcmToken" });

  try {
    // pamäť (live WS routing)
    if (!clients.has(userId)) clients.set(userId, { ws: null, fcmToken, role });
    else {
      const entry = clients.get(userId)!;
      entry.fcmToken = fcmToken;
      if (role) entry.role = role;
    }

    // DB persist (PushToken model)
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

// Friday routes mount
app.use("/api", fridayRoutes(prisma));

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});


app.get?.("/health", (_req, res) => res.json({ ok: true }));



// WebSocket
wss.on("connection", (ws: WebSocket) => {
  let currentUserId: string | null = null;

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (message: RawData) => {
    try {
      const data = JSON.parse(message.toString()) as any;

      // registrácia
      if (data.type === "register") {
        currentUserId = (data.userId as string) || null;
        if (!currentUserId) return;

        const r: Role | undefined = (data.role as Role | undefined) || clients.get(currentUserId)?.role;

        if (!clients.has(currentUserId)) {
          clients.set(currentUserId, { ws, role: r });
        } else {
          const entry = clients.get(currentUserId)!;
          entry.ws = ws;
          if (r) entry.role = r;
        }

        console.log(`✅ ${currentUserId} (${r || "unknown"}) connected via WS`);

        // pending prichádzajúci hovor
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

      // klient žiada hovor s adminom
      if (data.type === "call-request") {
        const targetId = data.targetId as string | undefined;
        const callerName = (data.callerName as string) || "";
        if (!currentUserId || !targetId) return;

        if (isFridayInBratislava()) {
          const minutes = await fridayMinutes(currentUserId);
          if (minutes <= 0) {
            const caller = clients.get(currentUserId);
            if (caller?.ws && caller.ws.readyState === WebSocket.OPEN) {
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
        if (target?.ws && target.ws.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: "incoming-call", callerId: currentUserId, callerName }));
          } catch (e) {
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
            await admin.messaging().send({
              token: targetToken,
              notification: { title: "Prichádzajúci hovor", body: `${callerName} ti volá` },
              data: { type: "incoming_call", callerId: currentUserId, callerName },
            });
            console.log(`📩 Push notification sent to ${targetId}`);
          }
        } catch (e) {
          console.error("❌ FCM send error:", e);
        }
      }

      // WebRTC forward + billing štart pri answeri
      if (["webrtc-offer", "webrtc-answer", "webrtc-candidate", "request-offer"].includes(data.type)) {
        if (!currentUserId || !data.targetId) return;

        const target = clients.get(data.targetId as string);
        if (target?.ws && target.ws.readyState === WebSocket.OPEN) {
          try {
            const payload = { ...data, from: currentUserId };
            target.ws.send(JSON.stringify(payload));
          } catch (e) {
            console.error(`❌ WS forward ${data.type} error:`, e);
          }
        }

        // ANSWER → začni billing len v piatok
        if (data.type === "webrtc-answer") {
          const callerId = data.targetId as string;
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
                  if (isFridayInBratislava()) {
                    const deficit = await consumeFridaySeconds(callerId, 10);
                    const minutesLeft = await fridayMinutes(callerId);

                    const caller = clients.get(callerId);
                    if (caller?.ws && caller.ws.readyState === WebSocket.OPEN) {
                      caller.ws.send(
                        JSON.stringify({ type: "friday-balance-update", minutesRemaining: minutesLeft })
                      );
                    }

                    if (deficit > 0 || minutesLeft <= 0) {
                      const msg = JSON.stringify({ type: "end-call", reason: "no-friday-tokens" });
                      const callee = clients.get(calleeId);
                      try {
                        caller?.ws && caller.ws.readyState === WebSocket.OPEN && caller.ws.send(msg);
                      } catch {}
                      try {
                        callee?.ws && callee.ws.readyState === WebSocket.OPEN && callee.ws.send(msg);
                      } catch {}

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
                  // mimo piatku: nič neúčtujeme
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

              const callerEntry = clients.get(callerId);
              if (callerEntry?.ws && callerEntry.ws.readyState === WebSocket.OPEN) {
                callerEntry.ws.send(JSON.stringify({ type: "call-started", from: calleeId }));
              }
            } catch (e) {
              console.error("callSession start error:", e);
            }
          }
        }
      }

      // manuálne ukončenie hovoru
      if (data.type === "end-call") {
        const target = clients.get(data.targetId as string);
        if (target?.ws && target.ws.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: "end-call", from: currentUserId }));
          } catch (e) {
            console.error("❌ WS end-call forward error:", e);
          }
        }

        if (currentUserId) {
          const key = callKeyFor(currentUserId, data.targetId as string);
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

// Removed invalid wss "close" event listener; cleanup is handled by process signals below.

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