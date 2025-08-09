require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
const admin = require("./firebase-admin");

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

/**
 * WebSocket spojenie
 */
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
            // už ho nepotrebujeme držať
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
      }

      // (voliteľné) ukončenie hovoru
      if (data.type === "end-call") {
        const target = clients.get(data.targetId);
        if (target?.ws?.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: "end-call", from: currentUserId }));
          } catch (e) {
            console.error("❌ WS end-call forward error:", e);
          }
        }
      }
    } catch (err) {
      console.error("❌ WS message error:", err);
    }
  });

  ws.on("close", () => {
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

// WS keepalive (pomôže na niektorých hostingoch)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping(() => {});
    } catch (e) {
      // ignore
    }
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
