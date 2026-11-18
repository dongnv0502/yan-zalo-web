// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadType, ZaloApiError } from "zca-js";
import type { ChatMessage } from "@/types/chat";
import { POST } from "./route";

const { getZaloSession, getMessageProtocol, undo, isCurrent } = vi.hoisted(() => ({
  getZaloSession: vi.fn(), getMessageProtocol: vi.fn(), undo: vi.fn(), isCurrent: vi.fn(),
}));
vi.mock("@/lib/zalo", () => ({ getZaloSession }));
vi.mock("@/lib/messageStore", () => ({ getMessageProtocol }));

const ownId = "own-account";
const key = { threadId: "contact", threadType: "User", messageId: "stored-id" } as const;
const message: ChatMessage = {
  id: key.messageId, threadId: key.threadId, threadType: key.threadType,
  fromId: ownId, fromName: "Tôi", ts: 1, content: "Original", isSelf: true,
};
const identity = { globalId: "90071992547409999", cliId: "123", senderId: ownId };
const recalledMessage = { ...message, content: "", recalled: true };
const makeRequest = (body: unknown = key, cookie = "test") => new NextRequest("http://localhost/api/chat/recall", {
  method: "POST", body: JSON.stringify(body), headers: { Cookie: `zalo_sid=${cookie}` },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ZALO_CHAT_RECALL_VERIFIED", "true");
  getZaloSession.mockImplementation(sid => sid === "test" ? { api: { undo }, accountId: ownId, isCurrent } : null);
  getMessageProtocol.mockImplementation((account, scope) => (
    account === ownId && scope.threadId === key.threadId && scope.threadType === key.threadType && scope.messageId === key.messageId
      ? { message, identity } : undefined
  ));
  isCurrent.mockReturnValue(true);
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(60_000);
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("POST /api/chat/recall", () => {
  it("requires an authenticated session", async () => {
    expect((await POST(makeRequest(key, "invalid"))).status).toBe(401);
    expect(undo).not.toHaveBeenCalled();
  });

  it("is default-closed and requires the exact true gate", async () => {
    for (const value of [undefined, "TRUE", "1", "false"]) {
      vi.stubEnv("ZALO_CHAT_RECALL_VERIFIED", value);
      expect((await POST(makeRequest())).status).toBe(503);
    }
    expect(undo).not.toHaveBeenCalled();
  });

  it("validates JSON, selector type, and exact scope", async () => {
    expect((await POST(makeRequest(null))).status).toBe(400);
    expect((await POST(makeRequest({ ...key, threadType: "other" }))).status).toBe(400);
    expect((await POST(makeRequest({ ...key, messageId: 123 }))).status).toBe(400);
    expect((await POST(makeRequest({ ...key, threadType: "Group" }))).status).toBe(404);
    expect((await POST(makeRequest({ ...key, threadId: "other" }))).status).toBe(404);
    getZaloSession.mockReturnValue({ api: { undo }, accountId: "other", isCurrent });
    expect((await POST(makeRequest())).status).toBe(404);
    expect(undo).not.toHaveBeenCalled();
  });

  it("rejects another sender and records missing a protocol ID", async () => {
    getMessageProtocol.mockReturnValue({ message: { ...message, isSelf: false, fromId: "other" }, identity });
    expect((await POST(makeRequest())).status).toBe(403);
    getMessageProtocol.mockReturnValue({ message, identity: { globalId: identity.globalId, senderId: ownId } });
    expect((await POST(makeRequest())).status).toBe(409);
    expect(undo).not.toHaveBeenCalled();
  });

  it("returns a committed tombstone without another SDK write", async () => {
    getMessageProtocol.mockReturnValue({ message: recalledMessage });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "confirmed", message: recalledMessage });
    expect(undo).not.toHaveBeenCalled();
  });

  it("gives durable confirmation precedence over an explicit upstream rejection", async () => {
    const threadId = "group-recalled-during-request";
    const groupMessage = { ...message, threadId, threadType: "Group" } as const;
    getMessageProtocol.mockReturnValue({ message: groupMessage, identity });
    undo.mockImplementationOnce(async () => {
      getMessageProtocol.mockReturnValue({ message: { ...groupMessage, content: "", recalled: true } });
      throw new ZaloApiError("Upstream detail", 401);
    });
    const response = await POST(makeRequest({ ...key, threadId, threadType: "Group" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "confirmed", message: { ...groupMessage, content: "", recalled: true } });
    expect(undo).toHaveBeenCalledExactlyOnceWith({ msgId: identity.globalId, cliMsgId: identity.cliId }, threadId, ThreadType.Group);
  });

  it("reports explicit rejection without leaking the SDK error", async () => {
    undo.mockRejectedValueOnce(new ZaloApiError("Sensitive upstream detail", 108));
    const response = await POST(makeRequest());
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("Sensitive upstream detail");
  });

  it("bounds time spent reading the request before any SDK call can start", async () => {
    const request = makeRequest();
    vi.spyOn(request, "json").mockReturnValue(Promise.withResolvers<unknown>().promise);
    const pending = POST(request);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await pending).status).toBe(408);
    expect(undo).not.toHaveBeenCalled();
  });

  it("returns pending after SDK resolve and blocks duplicates throughout the confirmation window", async () => {
    getMessageProtocol.mockReturnValue({ message: { ...message, id: "pending" }, identity });
    const request = () => makeRequest({ ...key, messageId: "pending" });
    undo.mockResolvedValue({ status: 123 });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await (await POST(request())).json()).toEqual({ status: "pending" });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("classifies transport or parse failure as unknown without retrying the write", async () => {
    getMessageProtocol.mockReturnValue({ message: { ...message, id: "parse-failure" }, identity });
    const request = () => makeRequest({ ...key, messageId: "parse-failure" });
    undo.mockRejectedValue(new ZaloApiError("Failed to parse response data"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "unknown" });
    expect(await (await POST(request())).json()).toEqual({ status: "unknown" });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("is single-flight while undo runs, bounds an unresolved SDK wait, and reports unknown after timeout", async () => {
    const threadId = "timed-out-request";
    getMessageProtocol.mockReturnValue({ message: { ...message, threadId }, identity });
    const started = Promise.withResolvers<void>();
    undo.mockImplementationOnce(() => {
      started.resolve();
      return Promise.withResolvers<unknown>().promise;
    });
    const request = () => makeRequest({ ...key, threadId });
    const pending = POST(request());
    await started.promise;
    expect(await (await POST(request())).json()).toEqual({ status: "pending" });
    await vi.advanceTimersByTimeAsync(4_000);
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "unknown" });
    expect(await (await POST(request())).json()).toEqual({ status: "unknown" });
    expect(undo).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(26_000);
    expect(undo).toHaveBeenCalledTimes(1);
    undo.mockResolvedValueOnce({ status: 0 });
    expect(await (await POST(request())).json()).toEqual({ status: "pending" });
    expect(undo).toHaveBeenCalledTimes(2);
  });
});
