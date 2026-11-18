// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadType, type SendMessageQuote } from "zca-js";
import type { ChatMessage } from "@/types/chat";
import { POST } from "./route";

const { getZaloSession, getMessageProtocol, commitMessage, publishSessionEvent, sendMessage, isCurrent } = vi.hoisted(() => ({
  getZaloSession: vi.fn(), getMessageProtocol: vi.fn(), commitMessage: vi.fn(), publishSessionEvent: vi.fn(),
  sendMessage: vi.fn(), isCurrent: vi.fn(),
}));
vi.mock("@/lib/zalo", () => ({ getZaloSession }));
vi.mock("@/lib/messageStore", () => ({ getMessageProtocol, commitMessage }));
vi.mock("@/lib/socketServer", () => ({ publishSessionEvent }));

const accountId = "owner";
const session = { api: { sendMessage }, accountId, isCurrent };
const input = { threadType: "User", threadId: "contact", text: "  reply text  " } as const;
const quote: SendMessageQuote = {
  content: "Original quote", msgType: "webchat", propertyExt: undefined,
  uidFrom: "sender", msgId: "333", cliMsgId: "234", ts: "123", ttl: 0,
};
const original: ChatMessage = {
  id: "local-id", threadId: input.threadId, threadType: input.threadType, content: "Original quote",
  fromName: "Sender", fromId: "sender", isSelf: false, ts: 123,
};
const preview = { targetId: original.id, fromName: "Sender", text: "Original quote" };
const makeRequest = (body: unknown = input, cookie = "test") => new NextRequest("http://localhost/api/chat/send", {
  method: "POST", body: JSON.stringify(body), headers: { Cookie: `zalo_sid=${cookie}` },
});

beforeEach(() => {
  vi.stubEnv("ZALO_CHAT_REPLY_VERIFIED", "true");
  getZaloSession.mockImplementation(sid => sid === "test" ? session : null);
  isCurrent.mockReturnValue(true);
  sendMessage.mockResolvedValue({ message: { msgId: 222 }, attachment: [] });
  commitMessage.mockImplementation((_, message: ChatMessage) => ({ message, changed: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/chat/send", () => {
  it("requires an authenticated session and validates the request body", async () => {
    expect((await POST(makeRequest(input, "invalid"))).status).toBe(401);
    expect((await POST(makeRequest(null))).status).toBe(400);
    expect((await POST(makeRequest({ ...input, threadType: "Other" }))).status).toBe(400);
    expect((await POST(makeRequest({ ...input, replyToId: 123 }))).status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("retains ordinary string sends when quote is disabled, and returns the committed DTO", async () => {
    vi.stubEnv("ZALO_CHAT_REPLY_VERIFIED", undefined);
    const committed: ChatMessage = { ...original, id: "222", fromId: accountId, fromName: "Tôi", isSelf: true, content: "reply text" };
    commitMessage.mockReturnValue({ message: committed, changed: true });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: committed });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("reply text", input.threadId, ThreadType.User);
    expect(publishSessionEvent).toHaveBeenCalledExactlyOnceWith(session, "message", committed);
  });

  it("does not fall back to sending ordinary text with a default-closed quote gate", async () => {
    for (const value of [undefined, "TRUE", "false"]) {
      vi.stubEnv("ZALO_CHAT_REPLY_VERIFIED", value);
      expect((await POST(makeRequest({ ...input, replyToId: original.id }))).status).toBe(503);
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["User", "Group"] as const)("quotes only stored metadata in a %s thread", async threadType => {
    getMessageProtocol.mockImplementation((account, key) => account === accountId && key.threadId === input.threadId && key.threadType === threadType && key.messageId === original.id
      ? { message: { ...original, threadType }, quote } : undefined);
    const response = await POST(makeRequest({ ...input, threadType, replyToId: original.id, quote: { content: "Injected" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: expect.objectContaining({ id: "222", content: "reply text", quote: preview }) });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ msg: "reply text", quote }, input.threadId, ThreadType[threadType]);
    expect(commitMessage).toHaveBeenCalledWith(accountId, expect.objectContaining({ quote: preview }), true,
      expect.objectContaining({ identity: { globalId: "222", senderId: accountId }, source: "ack", quoteTarget: { id: original.id, senderId: original.fromId } }));
  });

  it("does not quote across account, thread ID, or type boundaries", async () => {
    getMessageProtocol.mockImplementation((account, key) => account === "other-account" || key.threadId === "other-thread" || key.threadType === "Group"
      ? { message: original, quote } : undefined);
    const response = await POST(makeRequest({ ...input, replyToId: original.id }));
    expect(response.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects legacy or recalled quote targets without sending text", async () => {
    getMessageProtocol.mockReturnValueOnce({ message: original });
    expect((await POST(makeRequest({ ...input, replyToId: original.id }))).status).toBe(409);
    getMessageProtocol.mockReturnValueOnce({ message: { ...original, recalled: true }, quote });
    expect((await POST(makeRequest({ ...input, replyToId: original.id }))).status).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not publish or save after a rejected SDK send", async () => {
    sendMessage.mockRejectedValueOnce(new Error("Sensitive upstream detail"));
    const response = await POST(makeRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Sensitive upstream detail");
    expect(commitMessage).not.toHaveBeenCalled();
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });

  it("reports sent-not-saved after persistence fails without sending again", async () => {
    commitMessage.mockImplementationOnce(() => { throw new Error("SQLite write failed"); });
    const response = await POST(makeRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "sent-not-saved" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });

  it("does not create a canonical row from a rounded numeric ACK", async () => {
    sendMessage.mockResolvedValueOnce({ message: { msgId: Number.MAX_SAFE_INTEGER + 1 }, attachment: [] });
    const response = await POST(makeRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "sent-not-saved" });
    expect(commitMessage).not.toHaveBeenCalled();
  });

  it("retains an exact large ID and returns an echo-first DTO without republishing it", async () => {
    const id = "9223372036854775807";
    const echo: ChatMessage = { ...original, id, fromId: accountId, isSelf: true, content: "reply text", canRecall: true };
    sendMessage.mockResolvedValueOnce({ message: { msgId: id }, attachment: [] });
    commitMessage.mockReturnValueOnce({ message: echo, changed: false });
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: echo });
    expect(commitMessage).toHaveBeenCalledWith(accountId, expect.objectContaining({ id }), true,
      expect.objectContaining({ identity: { globalId: id, senderId: accountId } }));
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });

  it("still returns a committed message when socket delivery fails", async () => {
    const committed: ChatMessage = { ...original, id: "222", fromId: accountId, isSelf: true, content: "reply text" };
    commitMessage.mockReturnValueOnce({ message: committed, changed: true });
    publishSessionEvent.mockImplementationOnce(() => { throw new Error("Socket unavailable"); });
    const warning = vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    try {
      const response = await POST(makeRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: committed });
    } finally {
      warning.mockRestore();
    }
  });

  it("does not persist or publish if the captured session is revoked during the SDK request", async () => {
    sendMessage.mockImplementationOnce(async () => {
      isCurrent.mockReturnValue(false);
      return { message: { msgId: 222 }, attachment: [] };
    });
    const response = await POST(makeRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "sent-not-saved" });
    expect(commitMessage).not.toHaveBeenCalled();
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });
});
