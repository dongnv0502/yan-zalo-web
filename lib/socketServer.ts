import { Server } from "socket.io";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { ChatMessage, ThreadType } from "@/types/chat";
import { getZaloSession, type GroupEventLog, type ZaloSession } from "./zalo";

interface MessageInvalidation {
  threadId: string;
  threadType: ThreadType;
  messageId: string;
  namespace?: "global";
}

interface SessionEvents {
  message: (message: ChatMessage, options?: { mediaUpdate?: true; mergedId?: string }) => void;
  group_event: (event: GroupEventLog) => void;
  message_reaction: (event: { threadId: string; threadType: ThreadType; msgId: string;
    icon: string; senderId: string; senderName: string }) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __ioServer: Server | undefined;
}

function matchesAppOrigin(request: IncomingMessage): boolean {
  const { origin, host, upgrade } = request.headers;
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  try {
    // Prefer an explicit public origin when a terminating proxy rewrites Host.
    // A forwarded host is not authoritative; when preserving Host the proxy should set the scheme.
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol = request.socket instanceof TLSSocket || forwardedProto === "https" ? "https" : "http";
    const configuredOrigin = process.env.ZALO_APP_ORIGIN;
    if (!configuredOrigin && (!host || /[\\/@?#,\s]/.test(host))) return false;
    const publicURL = new URL(configuredOrigin || `${protocol}://${host}`);
    if (!/^https?:$/.test(publicURL.protocol) || publicURL.href !== `${publicURL.origin}/`) return false;
    if (origin !== undefined) return origin === publicURL.origin;

    // Same-origin browser XHR can omit Origin on polling GETs. Require Fetch Metadata
    // and do not accept Origin-less WebSocket requests or cross-origin preflights.
    return upgrade === undefined && fetchSite === "same-origin" && request.method !== "OPTIONS";
  } catch {
    return false;
  }
}

function sessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  let sid: string | null = null;
  for (const cookie of header.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1 || cookie.slice(0, separator).trim() !== "zalo_sid") continue;
    if (sid !== null) return null;
    try {
      sid = decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return null;
    }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sid)) return null;
  }
  return sid;
}

export function initSocketServer(httpServer: HttpServer): Server {
  if (global.__ioServer) return global.__ioServer;

  const io = new Server(httpServer, { path: "/api/socketio" });
  // Engine middleware covers each polling request and the WebSocket upgrade, not only the initial handshake.
  io.engine.use((request: IncomingMessage, _response: ServerResponse, next: (error?: Error) => void) => {
    next(matchesAppOrigin(request) ? undefined : new Error("Forbidden origin"));
  });

  io.use((socket, next) => {
    const sid = sessionCookie(socket.handshake.headers.cookie);
    const session = sid && getZaloSession(sid);
    if (!session) return next(new Error("Not logged in"));
    socket.data.session = session;
    next();
  });

  io.on("connection", async socket => {
    const session: ZaloSession = socket.data.session;
    if (!session.isCurrent()) {
      socket.disconnect(true);
      return;
    }
    try {
      await socket.join([`session:${session.generation}`, `account:${session.accountId}`]);
      if (!session.isCurrent()) {
        socket.disconnect(true);
        return;
      }
      socket.on("chat:subscribe", (ack: unknown) => {
        if (typeof ack === "function" && session.isCurrent()) ack({ ok: true, generation: session.generation });
      });
    } catch {
      socket.disconnect(true);
    }
  });

  global.__ioServer = io;
  return io;
}

export function revokeSessionSockets(session: ZaloSession): void {
  global.__ioServer?.in(`session:${session.generation}`).disconnectSockets(true);
}

export function publishSessionEvent<Event extends keyof SessionEvents>(
  session: ZaloSession, event: Event, ...args: Parameters<SessionEvents[Event]>
): void {
  if (session.isCurrent()) global.__ioServer?.to(`session:${session.generation}`).emit(event, ...args);
}

export function publishAccountInvalidation(session: ZaloSession, { threadId, threadType, messageId, namespace }: MessageInvalidation): void {
  if (session.isCurrent()) {
    global.__ioServer?.to(`account:${session.accountId}`).emit("message_recalled", { threadId, threadType, messageId, ...(namespace && { namespace }) });
  }
}
