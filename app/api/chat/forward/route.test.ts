// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import type { ChatMessage } from "@/types/chat";
import { POST } from "./route";

const { getZaloSession, getMessageProtocol, forwardMessage, isCurrent } = vi.hoisted(() => ({
  getZaloSession: vi.fn(), getMessageProtocol: vi.fn(), forwardMessage: vi.fn(), isCurrent: vi.fn(),
}));
vi.mock("@/lib/zalo", () => ({ getZaloSession }));
vi.mock("@/lib/messageStore", () => ({ getMessageProtocol }));

const accountId = "account-one";
const source = { threadId: "source", threadType: "User", messageId: "stored-1" } as const;
const body = {
  sourceThreadId: source.threadId, sourceThreadType: source.threadType, messageId: source.messageId,
  targetThreadId: "target", targetThreadType: "Group",
};
const message: ChatMessage = {
  id: source.messageId, threadId: source.threadId, threadType: source.threadType,
  fromId: "sender", fromName: "Sender", content: "Stored content", isSelf: false, ts: 55,
};
const identity = { globalId: "777", senderId: "sender" };
const makeRequest = (payload: unknown = body, sid = "test") => new NextRequest("http://localhost/api/chat/forward", {
  method: "POST", body: JSON.stringify(payload), headers: { Cookie: `zalo_sid=${sid}` },
});

beforeEach(() => {
  getZaloSession.mockImplementation(sid => sid === "test" ? { api: { forwardMessage }, accountId, isCurrent } : null);
  getMessageProtocol.mockImplementation((account, key) => account === accountId && key.threadId === source.threadId
    && key.threadType === source.threadType && key.messageId === source.messageId ? { message, identity } : undefined);
  isCurrent.mockReturnValue(true);
});
afterEach(() => vi.resetAllMocks());

describe("POST /api/chat/forward", () => {
  it("requires authentication and a valid selector for both threads", async () => {
    expect((await POST(makeRequest(body, "invalid"))).status).toBe(401);
    expect((await POST(makeRequest({ ...body, sourceThreadType: "Other" }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, targetThreadType: "Other" }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, targetThreadId: null }))).status).toBe(400);
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it("forwards stored content and protocol metadata, never supplied values", async () => {
    forwardMessage.mockResolvedValue({ success: [{ clientId: "1", msgId: "789" }], fail: [] });
    const response = await POST(makeRequest({ ...body, messageContent: "Forged", messageTs: 777, globalId: "555" }));
    expect(response.status).toBe(200);
    expect(forwardMessage).toHaveBeenCalledExactlyOnceWith({
      message: "Stored content", reference: { id: "777", ts: 55, logSrcType: 0, fwLvl: 0 },
    }, ["target"], ThreadType.Group);
    expect(await response.json()).toEqual({ success: true });
  });

  it("does not forward a source outside the exact account, type, and thread", async () => {
    expect((await POST(makeRequest({ ...body, sourceThreadId: "other" }))).status).toBe(404);
    expect((await POST(makeRequest({ ...body, sourceThreadType: "Group" }))).status).toBe(404);
    getZaloSession.mockReturnValue({ api: { forwardMessage }, accountId: "other", isCurrent });
    expect((await POST(makeRequest())).status).toBe(404);
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it("does not forward a recalled source", async () => {
    getMessageProtocol.mockReturnValue({ message: { ...message, recalled: true }, identity });
    expect((await POST(makeRequest({ ...body, messageContent: "Cached original" }))).status).toBe(409);
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it("keeps legacy text forwarding without fabricating a protocol reference", async () => {
    getMessageProtocol.mockReturnValue({ message });
    forwardMessage.mockResolvedValue({ success: [{ clientId: "1", msgId: "789" }], fail: [] });
    expect((await POST(makeRequest())).status).toBe(200);
    expect(forwardMessage).toHaveBeenCalledExactlyOnceWith({ message: "Stored content" }, ["target"], ThreadType.Group);
  });

  it("returns an error when forwarding fails, without exposing SDK payloads", async () => {
    forwardMessage.mockResolvedValueOnce({ success: [], fail: [{ clientId: "private-id", error_code: "403" }] });
    const rejected = await POST(makeRequest());
    expect(rejected.status).toBe(422);
    expect(await rejected.text()).not.toContain("private-id");
    forwardMessage.mockRejectedValueOnce(new Error("Private upstream detail"));
    const failed = await POST(makeRequest());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("Private upstream detail");
  });
});
