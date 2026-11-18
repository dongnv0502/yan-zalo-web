import { randomUUID } from "node:crypto";
import { Zalo, type API, LoginQRCallbackEventType } from "zca-js";
import { publishSessionEvent, revokeSessionSockets } from "./socketServer";
import { updateMessageReaction } from "./messageStore";
import { ingestZaloMessage, ingestZaloUndo } from "./chatIngest";
import { readProtocolId } from "./chatProtocol";

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
  return [...(global.__zaloGroupEvents?.get(sessionId) ?? [])];
}

export function clearGroupEvents(sessionId: string): void {
  global.__zaloGroupEvents?.delete(sessionId);
}

export interface ZaloSession {
  readonly api: API;
  readonly accountId: string;
  readonly generation: string;
  isCurrent(): boolean;
}

interface ZaloState {
  status: LoginStatus;
  session: ZaloSession | null;
  error: string | null;
  qrImageBase64: string | null;
  cancelQR?: () => void;
  restoring?: Promise<boolean>;
}

declare global {
  // eslint-disable-next-line no-var
  var __zaloSessions: Map<string, ZaloState> | undefined;
}

function getSessionMap(): Map<string, ZaloState> {
  if (!global.__zaloSessions) global.__zaloSessions = new Map();
  return global.__zaloSessions;
}

export function getLoginStatus(sessionId: string): LoginStatus {
  return global.__zaloSessions?.get(sessionId)?.status ?? "idle";
}

export function getZaloSession(sessionId: string): ZaloSession | null {
  return global.__zaloSessions?.get(sessionId)?.session ?? null;
}

export function getZaloApi(sessionId: string): API | null {
  return getZaloSession(sessionId)?.api ?? null;
}

export function isLoggedIn(sessionId: string): boolean {
  return getZaloSession(sessionId) !== null;
}

export function getLoginError(sessionId: string): string | null {
  return global.__zaloSessions?.get(sessionId)?.error ?? null;
}

export function getQRImageBase64(sessionId: string): string | null {
  return global.__zaloSessions?.get(sessionId)?.qrImageBase64 ?? null;
}

export function getSessionForClient(sessionId: string): { imei: string; userAgent: string; cookies: unknown[] } | null {
  const api = getZaloApi(sessionId);
  if (!api) return null;
  try {
    const ctx = api.getContext();
    const cookieJar = api.getCookie();
    const cookies = (cookieJar.toJSON() as { cookies: unknown[] }).cookies;
    return { imei: ctx.imei, userAgent: ctx.userAgent, cookies };
  } catch {
    return null;
  }
}

function activateSession(sessionId: string, state: ZaloState, api: API): boolean {
  if (global.__zaloSessions?.get(sessionId) !== state) return false;
  const accountId = api.getOwnId();
  if (typeof accountId !== "string" || !accountId) return false;
  const session: ZaloSession = {
    api, accountId, generation: randomUUID(),
    isCurrent: () => global.__zaloSessions?.get(sessionId)?.session === session,
  };
  state.session = session;
  try {
    wireMessageListener(session, sessionId);
    // The SDK's queued retry calls listener.start() even after stop(). Guard the public
    // entry point so a stale retry cannot reopen the upstream listener after logout.
    const start = api.listener.start.bind(api.listener);
    api.listener.start = options => {
      if (session.isCurrent()) start(options);
    };
    api.listener.start({ retryOnClose: true });
    state.status = "logged_in";
    state.qrImageBase64 = null;
    return true;
  } catch {
    state.session = null;
    stopListener(api);
    return false;
  }
}

function stopListener(api: API): void {
  try {
    api.listener.stop();
  } catch {
    console.error("[zalo] Không dừng được trình nghe sự kiện");
  }
}

export async function restoreFromSession(data: unknown, sessionId: string): Promise<boolean> {
  if (getZaloSession(sessionId)) return true;
  if (!data || typeof data !== "object") return false;
  const { imei, userAgent, cookies } = data as Record<string, unknown>;
  if (typeof imei !== "string" || !imei || typeof userAgent !== "string" || !userAgent || !Array.isArray(cookies) ||
    !cookies.every(cookie => cookie && typeof cookie === "object" && !Array.isArray(cookie))) return false;

  const previous = global.__zaloSessions?.get(sessionId);
  if (previous?.restoring) return previous.restoring;
  const state: ZaloState = { status: "idle", session: null, error: null, qrImageBase64: null };
  getSessionMap().set(sessionId, state);
  previous?.cancelQR?.();

  const restoring = Promise.resolve().then(async () => {
    if (global.__zaloSessions?.get(sessionId) !== state) return false;
    try {
      const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false });
      const api = await zalo.login({ cookie: cookies as Parameters<Zalo["login"]>[0]["cookie"], imei, userAgent });
      if (activateSession(sessionId, state, api)) return true;
    } catch {
      if (global.__zaloSessions?.get(sessionId) === state) console.error("[zalo] Không khôi phục được phiên");
    } finally {
      delete state.restoring;
    }
    if (global.__zaloSessions?.get(sessionId) === state) global.__zaloSessions.delete(sessionId);
    return false;
  });
  state.restoring = restoring;
  return restoring;
}

export async function startQRLogin(sessionId: string): Promise<void> {
  const status = getLoginStatus(sessionId);
  if (status === "logged_in" || status === "qr_generated") return;

  const state: ZaloState = { status: "qr_generated", session: null, error: null, qrImageBase64: null };
  getSessionMap().set(sessionId, state);

  // QR login runs in the background while the browser polls for the image and status.
  void finishQRLogin(sessionId, state);
}

async function finishQRLogin(sessionId: string, state: ZaloState): Promise<void> {
  const { promise: cancelled, reject } = Promise.withResolvers<never>();
  const timeout = setTimeout(() => reject(new Error("QR login timed out")), 30_000);
  let abort: (() => unknown) | undefined;
  let cancelledAttempt = false;
  state.cancelQR = () => {
    cancelledAttempt = true;
    reject(new Error("QR login cancelled"));
    abort?.();
  };

  const isActive = () => !cancelledAttempt && global.__zaloSessions?.get(sessionId) === state;
  try {
    const zalo = new Zalo({ selfListen: true, checkUpdate: false, logging: false });
    const login = zalo.loginQR({}, event => {
      if (!isActive()) {
        event.actions?.abort();
        return;
      }
      abort = event.actions?.abort;
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) state.qrImageBase64 = event.data.image;
    });
    const api = await Promise.race([login, cancelled]);
    if (isActive() && !activateSession(sessionId, state, api)) throw new Error("QR session could not start");
  } catch {
    if (isActive()) {
      state.status = "error";
      state.qrImageBase64 = null;
      state.error = "Không thể đăng nhập bằng mã QR";
      console.error("[zalo] Không đăng nhập được bằng mã QR");
      state.cancelQR();
    }
  } finally {
    clearTimeout(timeout);
    delete state.cancelQR;
  }
}

export async function regenerateQRLogin(sessionId: string): Promise<void> {
  resetLogin(sessionId);
  await startQRLogin(sessionId);
}

export function resetLogin(sessionId: string): void {
  const state = global.__zaloSessions?.get(sessionId);
  global.__zaloSessions?.delete(sessionId);
  clearGroupEvents(sessionId);
  state?.cancelQR?.();
  if (state?.session) {
    revokeSessionSockets(state.session);
    stopListener(state.session.api);
  }
}

function wireMessageListener(session: ZaloSession, sessionId: string): void {
  const { api, accountId } = session;
  api.listener.on("error", () => {
    if (session.isCurrent()) console.error("[zalo] Lỗi trình nghe sự kiện");
  });

  api.listener.on("message", async message => {
    if (!session.isCurrent()) return;
    try {
      await ingestZaloMessage(session, message, true);
    } catch {
      console.error("[zalo] Không lưu được tin nhắn realtime");
    }
  });

  api.listener.on("undo", (event) => {
    try {
      ingestZaloUndo(session, event);
    } catch {
      console.error("[zalo] Không lưu được sự kiện thu hồi");
    }
  });

  api.listener.on("group_event", ({ type, data, threadId }) => {
    if (!session.isCurrent()) return;
    try {
      const members = "updateMembers" in data && Array.isArray(data.updateMembers) ? data.updateMembers : [];
      const memberNames: string[] = [];
      const memberIds: string[] = [];
      for (const member of members) {
        if (member && typeof member === "object" && typeof member.id === "string" && typeof member.dName === "string") {
          memberNames.push(member.dName);
          memberIds.push(member.id);
        }
      }
      const log: GroupEventLog = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: String(type),
        groupId: ("groupId" in data ? data.groupId : threadId) ?? "",
        groupName: "groupName" in data ? data.groupName : "",
        memberNames,
        memberIds,
        ts: Date.now(),
      };

      const store = getEventStore(sessionId);
      store.unshift(log);
      if (store.length > MAX_GROUP_EVENTS) store.length = MAX_GROUP_EVENTS;

      publishSessionEvent(session, "group_event", log);
    } catch {
      console.error("[zalo] Không xử lý được sự kiện nhóm");
    }
  });

  api.listener.on("reaction", (event) => {
    if (!session.isCurrent()) return;
    try {
      const { data } = event;
      const threadId = event.threadId;
      const threadType = event.isGroup ? "Group" : "User";
      const icon = data.content?.rIcon;
      const senderId = String(data.uidFrom ?? "");
      const senderName = data.dName ?? senderId;

      if (!threadId || !icon) return;
      for (const target of data.content.rMsg ?? []) {
        const globalId = readProtocolId(target.gMsgID);
        if (!globalId) continue;
        const saved = updateMessageReaction(threadId, globalId, icon, senderId, senderName, accountId, threadType, "global");
        if (saved) publishSessionEvent(session, "message_reaction", { threadId, threadType, msgId: saved.id, icon, senderId, senderName });
      }
    } catch {
      console.error("[zalo] Không xử lý được reaction");
    }
  });
}
