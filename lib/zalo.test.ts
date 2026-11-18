import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock heavy / side-effectful dependencies so the module can be imported cleanly
vi.mock("zca-js", () => ({
  Zalo: vi.fn(),
  LoginQRCallbackEventType: { QRCodeGenerated: 0 },
  ThreadType: { User: "User", Group: "Group" },
}));

vi.mock("./socketServer", () => ({
  publishSessionEvent: vi.fn(),
  revokeSessionSockets: vi.fn(),
}));

vi.mock("./chatIngest", () => ({ ingestZaloMessage: vi.fn(), ingestZaloUndo: vi.fn() }));

vi.mock("./messageStore", () => ({
  storeMessage: vi.fn(),
  getMessages: vi.fn(() => []),
  updateMessageReaction: vi.fn(),
}));

// Import after mocks are registered
import {
  getGroupEvents,
  clearGroupEvents,
  getLoginStatus,
  getZaloApi,
  getZaloSession,
  getQRImageBase64,
  resetLogin,
  restoreFromSession,
  startQRLogin,
} from "./zalo";
import type { GroupEventLog } from "./zalo";
import { updateMessageReaction } from "./messageStore";
import { publishSessionEvent } from "./socketServer";
import { Zalo, type API, type LoginQRCallback } from "zca-js";
import { ingestZaloMessage } from "./chatIngest";

function makeEvent(overrides: Partial<GroupEventLog> = {}): GroupEventLog {
  return {
    id: "evt-1",
    type: "join",
    groupId: "g-1",
    groupName: "Test Group",
    memberNames: ["Alice"],
    memberIds: ["u-1"],
    ts: 1000,
    ...overrides,
  };
}

const credentials = { imei: "test", userAgent: "test", cookies: [] };

function fakeApi(accountId = "own-id") {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const start = vi.fn();
  const api = {
    getOwnId: () => accountId,
    listener: {
      on: vi.fn((event: string, handler: (event: unknown) => unknown) => { handlers[event] = handler; }),
      start,
      stop: vi.fn(),
    },
  };
  return { api, handlers, start };
}

async function restoreTestSession() {
  const { api, handlers } = fakeApi();
  vi.mocked(Zalo).mockImplementationOnce(() => ({ login: vi.fn().mockResolvedValue(api) }) as unknown as Zalo);
  expect(await restoreFromSession(credentials, "s1")).toBe(true);
  return handlers;
}

beforeEach(() => {
  global.__zaloGroupEvents = undefined;
  global.__zaloSessions = undefined;
  vi.clearAllMocks();
});

describe("getGroupEvents", () => {
  it("returns [] when no events have been recorded", () => {
    expect(getGroupEvents("s1")).toEqual([]);
  });

  it("returns a copy of stored events", () => {
    global.__zaloGroupEvents = new Map([["s1", [makeEvent()]]]);
    const result = getGroupEvents("s1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("evt-1");
    // Must be a copy, not the same array reference
    expect(result).not.toBe(global.__zaloGroupEvents.get("s1"));
  });
});

describe("clearGroupEvents", () => {
  it("empties the event store", () => {
    global.__zaloGroupEvents = new Map([["s1", [makeEvent(), makeEvent({ id: "evt-2" })]]]);
    clearGroupEvents("s1");
    expect(getGroupEvents("s1")).toEqual([]);
  });

  it("is a no-op when the store is already empty", () => {
    expect(() => clearGroupEvents("s1")).not.toThrow();
    expect(getGroupEvents("s1")).toEqual([]);
  });
});

describe("getLoginStatus", () => {
  it("returns 'idle' when no state has been initialized", () => {
    expect(getLoginStatus("s1")).toBe("idle");
  });
});

describe("authenticated reaction listener", () => {
  it("calls updateMessageReaction when a reaction event fires", async () => {
    const handlers = await restoreTestSession();

    handlers["reaction"]({
      threadId: "t-1",
      data: {
        msgId: "reaction-id",
        uidFrom: "u-2",
        dName: "Bob",
        content: { rIcon: "/-heart", rMsg: [{ gMsgID: "m-1" }] },
      },
    });

    expect(updateMessageReaction).toHaveBeenCalledWith("t-1", "m-1", "/-heart", "u-2", "Bob", "own-id", "User", "global");
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });

  it("publishes a group reaction to the authenticated session", async () => {
    const handlers = await restoreTestSession();
    vi.mocked(updateMessageReaction).mockReturnValueOnce({
      id: "m-1", threadId: "t-1", threadType: "Group", fromId: "u-2", fromName: "Bob", content: "test", ts: 123, isSelf: false,
    });

    handlers["reaction"]({
      threadId: "t-1",
      isGroup: true,
      data: { msgId: "reaction-id", uidFrom: "u-2", dName: "Bob", content: { rIcon: "/-heart", rMsg: [{ gMsgID: "m-1" }] } },
    });

    expect(publishSessionEvent).toHaveBeenCalledWith(getZaloSession("s1"), "message_reaction", expect.objectContaining({
      threadId: "t-1",
      threadType: "Group",
      msgId: "m-1",
      icon: "/-heart",
      senderId: "u-2",
      senderName: "Bob",
    }));
  });

  it("does nothing when icon is missing from reaction event", async () => {
    const handlers = await restoreTestSession();

    handlers["reaction"]({ threadId: "t-1", data: { msgId: "m-1", uidFrom: "u-2", content: {} } });

    expect(updateMessageReaction).not.toHaveBeenCalled();
  });
});

describe("session revocation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not reactivate a restore that finishes after logout or replace the newly authenticated account", async () => {
    const pending = Promise.withResolvers<API>();
    const old = fakeApi("old-account");
    const fresh = fakeApi("new-account");
    vi.mocked(Zalo).mockImplementationOnce(() => ({ login: () => pending.promise }) as unknown as Zalo);
    vi.mocked(Zalo).mockImplementationOnce(() => ({ login: vi.fn().mockResolvedValue(fresh.api) }) as unknown as Zalo);
    const oldRestore = restoreFromSession(credentials, "s1");
    await Promise.resolve();
    resetLogin("s1");
    expect(await restoreFromSession(credentials, "s1")).toBe(true);
    pending.resolve(old.api as unknown as API);
    expect(await oldRestore).toBe(false);
    expect(old.start).not.toHaveBeenCalled();
    expect(getZaloApi("s1")).toBe(fresh.api);
  });

  it("shares an in-flight restore between tabs without invalidating the first result", async () => {
    const pending = Promise.withResolvers<API>();
    const { api } = fakeApi();
    const login = vi.fn(() => pending.promise);
    vi.mocked(Zalo).mockImplementationOnce(() => ({ login }) as unknown as Zalo);
    const first = restoreFromSession(credentials, "s1");
    const second = restoreFromSession(credentials, "s1");
    pending.resolve(api as unknown as API);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(login).toHaveBeenCalledOnce();
  });

  it("ignores QR progress and completion from before logout", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<API>();
    const old = fakeApi();
    let callback!: LoginQRCallback;
    vi.mocked(Zalo).mockImplementationOnce(() => ({
      loginQR: (_options: unknown, onProgress: LoginQRCallback) => {
        callback = onProgress;
        return pending.promise;
      },
    }) as unknown as Zalo);
    await startQRLogin("s1");
    resetLogin("s1");
    const abort = vi.fn();
    callback({
      type: 0,
      data: { image: "image", code: "code", token: "test", options: { enabledCheckOCR: false, enabledMultiLayer: false } },
      actions: { abort, retry: vi.fn(), saveToFile: vi.fn() },
    });
    pending.resolve(old.api as unknown as API);
    await vi.advanceTimersByTimeAsync(0);
    expect(abort).toHaveBeenCalledOnce();
    expect(getQRImageBase64("s1")).toBeNull();
    expect(getLoginStatus("s1")).toBe("idle");
    expect(old.start).not.toHaveBeenCalled();
  });

  it("stops the old listener and drops queued message, group, and reaction callbacks", async () => {
    const old = fakeApi();
    const fresh = fakeApi();
    for (const api of [old.api, fresh.api]) {
      vi.mocked(Zalo).mockImplementationOnce(() => ({ login: vi.fn().mockResolvedValue(api) }) as unknown as Zalo);
    }
    expect(await restoreFromSession(credentials, "s1")).toBe(true);
    old.handlers.group_event({ type: "join", data: { groupId: "before" } });
    expect(getGroupEvents("s1")).toHaveLength(1);
    resetLogin("s1");
    expect(await restoreFromSession(credentials, "s1")).toBe(true);
    old.api.listener.start();
    expect(old.start).toHaveBeenCalledOnce();
    await old.handlers.message({});
    old.handlers.group_event({ type: "join", data: { groupId: "late" } });
    old.handlers.reaction({ threadId: "room", data: { content: { rIcon: "/-heart", rMsg: [{ gMsgID: "m-1" }] } } });
    expect(old.api.listener.stop).toHaveBeenCalledOnce();
    expect(ingestZaloMessage).not.toHaveBeenCalled();
    expect(getGroupEvents("s1")).toEqual([]);
    expect(updateMessageReaction).not.toHaveBeenCalled();
  });
});
