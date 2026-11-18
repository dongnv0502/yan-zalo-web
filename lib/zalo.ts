import { Zalo, API, LoginQRCallbackEventType } from "zca-js";
import { getSocketServer } from "./socketServer";
import { updateMessageReaction } from "./messageStore";
import { ingestZaloMessage } from "./chatIngest";

export type LoginStatus = "idle" | "qr_generated" | "logged_in" | "error";

// ── Group Event Log ────────────────────────────────────────────────────────────
export interface GroupEventLog {
  id: string;
  type: string;
  groupId: string;
  groupName: string;
  memberNames: string[];
  memberIds: string[];
  ts: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __zaloGroupEvents: Map<string, GroupEventLog[]> | undefined;
}

const MAX_GROUP_EVENTS = 500;

function getEventStore(sessionId: string): GroupEventLog[] {
  if (!global.__zaloGroupEvents) global.__zaloGroupEvents = new Map();
  if (!global.__zaloGroupEvents.has(sessionId)) global.__zaloGroupEvents.set(sessionId, []);
  return global.__zaloGroupEvents.get(sessionId)!;
}

export function getGroupEvents(sessionId: string): GroupEventLog[] {
  return [...getEventStore(sessionId)];
}

export function clearGroupEvents(sessionId: string): void {
  if (global.__zaloGroupEvents) global.__zaloGroupEvents.set(sessionId, []);
}

interface ZaloState {
  status: LoginStatus;
  api: API | null;
  error: string | null;
  qrImageBase64: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __zaloSessions: Map<string, ZaloState> | undefined;
}

function getSessionMap(): Map<string, ZaloState> {
  if (!global.__zaloSessions) global.__zaloSessions = new Map();
  return global.__zaloSessions;
}

function getState(sessionId: string): ZaloState {
  const map = getSessionMap();
  if (!map.has(sessionId)) {
    map.set(sessionId, { status: "idle", api: null, error: null, qrImageBase64: null });
  }
  return map.get(sessionId)!;
}

export function getLoginStatus(sessionId: string): LoginStatus {
  return getState(sessionId).status;
}

export function getZaloApi(sessionId: string): API | null {
  return getState(sessionId).api;
}

export function isLoggedIn(sessionId: string): boolean {
  return getState(sessionId).status === "logged_in";
}

export function getLoginError(sessionId: string): string | null {
  return getState(sessionId).error;
}

export function getQRImageBase64(sessionId: string): string | null {
  return getState(sessionId).qrImageBase64;
}

export function getSessionForClient(sessionId: string): { imei: string; userAgent: string; cookies: unknown[] } | null {
  const state = getState(sessionId);
  if (state.status !== "logged_in" || !state.api) return null;
  try {
    const ctx = state.api.getContext();
    const cookieJar = state.api.getCookie();
    const cookies = (cookieJar.toJSON() as { cookies: unknown[] }).cookies;
    return { imei: ctx.imei, userAgent: ctx.userAgent, cookies };
  } catch {
    return null;
  }
}

export async function restoreFromSession(
  data: { imei: string; userAgent: string; cookies: unknown[] },
  sessionId: string
): Promise<boolean> {
  const state = getState(sessionId);
  if (state.status === "logged_in") return true;
  try {
    const { imei, userAgent, cookies } = data;
    if (!imei || !userAgent || !Array.isArray(cookies)) return false;
    const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: API = await zalo.login({ cookie: cookies as any, imei, userAgent });
    state.api = api;
    state.status = "logged_in";
    state.error = null;
    wireMessageListener(api, sessionId);
    api.listener.start({ retryOnClose: true });
    console.log("[zalo] Restored session from client.", sessionId);
    return true;
  } catch (err) {
    console.error("[zalo] Session restore failed:", err);
    return false;
  }
}

export async function startQRLogin(sessionId: string): Promise<void> {
  const state = getState(sessionId);

  if (state.status === "logged_in") return;
  if (state.status === "qr_generated") return;

  state.status = "qr_generated";
  state.error = null;

  const zalo = new Zalo({
    selfListen: true,
    checkUpdate: false,
    logging: true,
  });

  const qrTimeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("QR login timeout: không thể kết nối đến máy chủ Zalo (id.zalo.me)")),
      30_000
    )
  );

  // Run login in background — resolves when user scans QR
  Promise.race([
    zalo.loginQR({}, (event) => {
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        state.qrImageBase64 = event.data.image;
      }
    }),
    qrTimeout,
  ])
    .then((api: API) => {
      state.api = api;
      state.status = "logged_in";
      state.qrImageBase64 = null;
      wireMessageListener(api, sessionId);
      api.listener.start({ retryOnClose: true });
    })
    .catch((err: Error) => {
      const cause = (err as Error & { cause?: unknown }).cause;
      console.error("[zalo] QR login failed:", err.message, cause ? `\n  cause: ${cause}` : "");
      state.status = "error";
      state.error = err?.message ?? "Unknown error";
    });
}

export async function regenerateQRLogin(sessionId: string): Promise<void> {
  resetLogin(sessionId);
  await startQRLogin(sessionId);
}

export function resetLogin(sessionId: string): void {
  const state = getState(sessionId);
  if (state.api) {
    try {
      state.api.listener.stop();
    } catch {
      // ignore
    }
  }
  state.status = "idle";
  state.api = null;
  state.error = null;
  state.qrImageBase64 = null;
}

export function wireMessageListener(api: API, sessionId: string): void {
  api.listener.on("message", async message => {
    try {
      await ingestZaloMessage(api, sessionId, message, true);
    } catch {
      console.error("[zalo] Không lưu được tin nhắn realtime");
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on("group_event", (event: any) => {
    try {
      const { type, data } = event;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const base = data as any;

      const log: GroupEventLog = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: String(type),
        groupId: base.groupId ?? "",
        groupName: base.groupName ?? "",
        memberNames: Array.isArray(base.updateMembers)
          ? base.updateMembers.map((m: { dName: string }) => m.dName)
          : [],
        memberIds: Array.isArray(base.updateMembers)
          ? base.updateMembers.map((m: { id: string }) => m.id)
          : [],
        ts: Date.now(),
      };

      const store = getEventStore(sessionId);
      store.unshift(log);
      if (store.length > MAX_GROUP_EVENTS) store.length = MAX_GROUP_EVENTS;

      const io = getSocketServer();
      if (io) {
        io.to(sessionId).emit("group_event", log);
      }
    } catch (err) {
      console.error("[zalo] group_event wiring error:", err);
    }
  });

  api.listener.on("reaction", (event) => {
    try {
      const { data } = event;
      const threadId = event.threadId;
      const threadType = event.isGroup ? "Group" : "User";
      const icon = data.content?.rIcon;
      const senderId = String(data.uidFrom ?? "");
      const senderName = data.dName ?? senderId;

      if (!threadId || !icon) return;
      const io = getSocketServer();
      for (const target of data.content.rMsg ?? []) {
        const msgId = String(target.gMsgID);
        updateMessageReaction(threadId, msgId, icon, senderId, senderName, api.getOwnId(), threadType);
        io?.to(sessionId).emit("message_reaction", { threadId, threadType, msgId, icon, senderId, senderName });
      }
    } catch (err) {
      console.error("[zalo] reaction wiring error:", err);
    }
  });
}
