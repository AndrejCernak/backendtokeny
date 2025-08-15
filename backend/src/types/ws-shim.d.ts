// src/types/ws-shim.d.ts
declare module "ws" {
  import { EventEmitter } from "events";
  import { Server as HttpServer } from "http";
  import { IncomingMessage } from "http";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readyState: number;
    protocol: string;
    binaryType: "nodebuffer" | "arraybuffer";
    // 🔧 keepalive flag, ktorú používaš
    isAlive?: boolean;

    send(data: any, cb?: (err?: Error) => void): void;
    close(code?: number, data?: string): void;
    ping(cb?: (err?: Error) => void): void;
    terminate(): void;

    on(event: "open" | "error" | "close" | "pong", listener: (...args: any[]) => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    clients: Set<WebSocket>;
    constructor(opts: { server?: HttpServer; port?: number });
    on(event: "connection", cb: (socket: WebSocket, request: IncomingMessage) => void): this;
  }
}