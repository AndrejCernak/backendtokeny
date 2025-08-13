// src/types/global.d.ts
declare namespace NodeJS {
  interface ProcessEnv {
    PORT?: string;
    FIREBASE_PROJECT_ID?: string;
    FIREBASE_PRIVATE_KEY_ID?: string;
    FIREBASE_PRIVATE_KEY?: string;
    FIREBASE_CLIENT_EMAIL?: string;

    FRIDAY_BASE_YEAR?: string;
    FRIDAY_BASE_PRICE_EUR?: string;
    MAX_PRIMARY_TOKENS_PER_USER?: string;
  }
}

// ws ping/pong keepalive – doplníme vlajku
// src/types/global.d.ts
import "ws";
declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}
