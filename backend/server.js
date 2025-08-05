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
  "http://localhost:3000" // lokálny vývoj
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
 * Map<userId, { ws: WebSocket, fcmToken?: string, role: 'client'|'admin' }>
 */
const clients = new Map();

/** 
 * API endpoint na registráciu FCM tokenu po prihlásení 
 */
app.post("/register-fcm", (req, res) => {
  const { userId, fcmToken, role } = req.body;
  if (!userId || !fcmToken) {
    return res.status(400).json({ error: "Missing userId or fcmToken" });
  }
  if (!clients.has(userId)) {
    clients.set(userId, { ws: null, fcmToken, role });
  } else {
    clients.get(userId).fcmToken = fcmToken;
    clients.get(userId).role = role;
  }
  res.json({ success: true });
});

/**
 * WebSocket spojenie
 */
wss.on("connection", (ws) => {
  let currentUserId = null;

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      // Registrácia užívateľa na WS
      if (data.type === "register") {
        currentUserId = data.userId;
        if (!clients.has(currentUserId)) {
          clients.set(currentUserId, { ws, role: data.role });
        } else {
          clients.get(currentUserId).ws = ws;
          clients.get(currentUserId).role = data.role;
        }
        console.log(`✅ ${currentUserId} (${data.role}) connected via WS`);
      }

      // Klient zavolá adminovi
      if (data.type === "call-request") {
        const { targetId, callerName } = data;
        console.log(`📞 Call request from ${currentUserId} to ${targetId}`);
        console.log("Current clients map:", [...clients.keys()]);
        const target = clients.get(targetId);
        if (target) {
          // Poslať WS event adminovi (ak je online)
          if (target.ws && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(
              JSON.stringify({
                type: "incoming-call",
                from: currentUserId,
                callerName,
              })
            );
          }

          // Poslať FCM notifikáciu
          if (target.fcmToken) {
            await admin.messaging().send({
              token: target.fcmToken,
              notification: {
                title: "Prichádzajúci hovor",
                body: `${callerName} ti volá`,
              },
              data: {
                type: "incoming_call",
                from: currentUserId,
                callerName,
              },
            });
            console.log(`📩 Push notification sent to ${targetId}`);
          }
        }
      }

      // WebRTC forwardovanie správ
      if (
        ["webrtc-offer", "webrtc-answer", "webrtc-candidate"].includes(
          data.type
        )
      ) {
        const target = clients.get(data.targetId);
        if (
          target &&
          target.ws &&
          target.ws.readyState === WebSocket.OPEN
        ) {
          target.ws.send(JSON.stringify(data));
        }
      }
    } catch (err) {
      console.error("❌ WS message error:", err);
    }
  });

  ws.on("close", () => {
    if (currentUserId && clients.has(currentUserId)) {
      clients.get(currentUserId).ws = null;
      console.log(`🔌 ${currentUserId} disconnected`);
    }
  });
});

server.listen(process.env.PORT, () => {
  console.log(`🚀 Backend running on port ${process.env.PORT}`);
});
