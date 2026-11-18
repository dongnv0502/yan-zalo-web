// @vitest-environment node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import type { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSocketServer, publishAccountInvalidation, publishSessionEvent } from "./socketServer";
import { getZaloSession, resetLogin, restoreFromSession } from "./zalo";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("zca-js", () => ({ Zalo: class { login = login; } }));
vi.mock("./messageStore", () => ({ updateMessageReaction: vi.fn() }));
vi.mock("./chatIngest", () => ({ ingestZaloMessage: vi.fn() }));

let server: Server;
let origin: string;
let clients: Socket[];

beforeEach(async () => {
  vi.stubEnv("ZALO_APP_ORIGIN", "");
  global.__zaloSessions = undefined;
  const httpServer = createServer();
  const listening = Promise.withResolvers<void>();
  httpServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  server = initSocketServer(httpServer);
  // The polling XHR client does not preserve a caller-supplied Host header.
  // Simulate the terminating proxy injecting the upstream Host on this test server.
  httpServer.prependListener("request", (request) => {
    if (request.headers["x-test-proxy"] === "public") request.headers.host = "app.example.test";
  });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) client.disconnect();
  await server.close();
  global.__ioServer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function signIn(accountId: string, sid = randomUUID()) {
  login.mockResolvedValueOnce({
    getOwnId: () => accountId,
    listener: { on: vi.fn(), start: vi.fn(), stop: vi.fn() },
  });
  if (!await restoreFromSession({ imei: "test", userAgent: "test", cookies: [] }, sid)) {
    throw new Error("Test session could not be restored");
  }
  return sid;
}

function openSocket(transport: "websocket" | "polling", headers: Record<string, string>, auth?: object) {
  const socket = io(origin, {
    path: "/api/socketio", transports: [transport], extraHeaders: headers, auth,
    forceNew: true, autoConnect: false, reconnection: false, timeout: 1200,
  });
  clients.push(socket);
  const { promise: result, resolve } = Promise.withResolvers<"connected" | "rejected">();
  socket.once("connect", () => resolve("connected"));
  socket.once("connect_error", () => resolve("rejected"));
  socket.connect();
  return { socket, result };
}

async function subscribed(transport: "websocket" | "polling", headers: Record<string, string>) {
  const { socket, result } = openSocket(transport, headers);
  expect(await result).toBe("connected");
  expect(await socket.timeout(1200).emitWithAck("chat:subscribe")).toEqual({ ok: true, generation: expect.any(String) });
  return socket;
}

function nextPayload(socket: Socket, event: string) {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  socket.once(event, resolve);
  return promise;
}

for (const transport of ["websocket", "polling"] as const) {
  describe(transport, () => {
    it("admits same-origin authenticated sockets and acknowledges subscription", async () => {
      const sid = await signIn("owner");
      await subscribed(transport, { Origin: origin, Cookie: `zalo_sid=${sid}` });
    });

    it("rejects absent, unknown, malformed, and ambiguous session cookies", async () => {
      const sid = await signIn("owner");
      for (const cookie of [undefined, `zalo_sid=${randomUUID()}`, "zalo_sid=%xx", `zalo_sid=${sid}; zalo_sid=${sid}`]) {
        const { result } = openSocket(transport, { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, { accountId: "owner" });
        expect(await result).toBe("rejected");
      }
    });

    it("rejects cross-origin and opaque-origin requests despite valid cookies", async () => {
      const sid = await signIn("owner");
      for (const badOrigin of ["https://unrelated.example.test", "null", origin.replace("http:", "https:")]) {
        const { result } = openSocket(transport, {
          Origin: badOrigin, Cookie: `zalo_sid=${sid}`, "X-Forwarded-Host": "unrelated.example.test",
        });
        expect(await result).toBe("rejected");
      }
    });

    it("admits proxy requests on the public origin, not on the internal host", async () => {
      const sid = await signIn("owner");
      const publicOrigin = "https://app.example.test";
      await subscribed(transport, { Origin: publicOrigin, Host: "app.example.test", "X-Test-Proxy": "public", "X-Forwarded-Proto": "https", Cookie: `zalo_sid=${sid}` });
      vi.stubEnv("ZALO_APP_ORIGIN", publicOrigin);
      await subscribed(transport, { Origin: publicOrigin, Cookie: `zalo_sid=${sid}` });
      expect(await openSocket(transport, { Origin: origin, Cookie: `zalo_sid=${sid}` }).result).toBe("rejected");
    });
  });
}

it("supports browser same-origin polling without an Origin header but rejects cross-site polling", async () => {
  const sid = await signIn("owner");
  const headers = { Cookie: `zalo_sid=${sid}` };
  await subscribed("polling", { ...headers, "Sec-Fetch-Site": "same-origin" });
  expect(await openSocket("polling", { ...headers, "Sec-Fetch-Site": "cross-site" }).result).toBe("rejected");
  expect(await openSocket("websocket", headers).result).toBe("rejected");
});

it("isolates per-session group events and invalidates every authenticated socket of only the originating account", async () => {
  const sid = await signIn("owner");
  const second = await signIn("owner");
  const other = await signIn("other");
  const headers = (sessionId: string) => ({ Origin: origin, Cookie: `zalo_sid=${sessionId}` });
  const originSocket = await subscribed("websocket", headers(sid));
  const secondSocket = await subscribed("websocket", headers(second));
  const otherSocket = await subscribed("websocket", headers(other));
  const unexpectedGroupEvent = vi.fn();
  const unexpectedInvalidation = vi.fn();
  secondSocket.on("group_event", unexpectedGroupEvent);
  otherSocket.on("message_recalled", unexpectedInvalidation);
  const session = getZaloSession(sid)!;
  const log = { id: "e-1", type: "join", groupId: "room", groupName: "Room", memberIds: [], memberNames: [], ts: 123 };
  const groupEvent = nextPayload(originSocket, "group_event");
  publishSessionEvent(session, "group_event", log);
  expect(await groupEvent).toEqual(log);

  const key = { messageId: "m-1", threadId: "room", threadType: "Group" } as const;
  const invalidations = [originSocket, secondSocket].map(socket => nextPayload(socket, "message_recalled"));
  publishAccountInvalidation(session, key);
  expect(await Promise.all(invalidations)).toEqual([key, key]);
  await Promise.all([secondSocket, otherSocket].map(socket => socket.timeout(1200).emitWithAck("chat:subscribe")));
  expect(unexpectedGroupEvent).not.toHaveBeenCalled();
  expect(unexpectedInvalidation).not.toHaveBeenCalled();
});

it("disconnects a logged-out socket and refuses stale publishers after relogin with the same cookie", async () => {
  const sid = await signIn("owner");
  const headers = { Origin: origin, Cookie: `zalo_sid=${sid}` };
  const oldSocket = await subscribed("websocket", headers);
  const oldSession = getZaloSession(sid)!;
  const disconnected = nextPayload(oldSocket, "disconnect");
  resetLogin(sid);
  expect(await disconnected).toBe("io server disconnect");
  expect(await openSocket("websocket", headers).result).toBe("rejected");

  await signIn("owner", sid);
  const newSocket = await subscribed("websocket", headers);
  const onInvalidation = vi.fn();
  newSocket.on("message_recalled", onInvalidation);
  const key = { messageId: "old", threadId: "room", threadType: "User" } as const;
  publishAccountInvalidation(oldSession, key);
  await newSocket.timeout(1200).emitWithAck("chat:subscribe");
  expect(onInvalidation).not.toHaveBeenCalled();
});
