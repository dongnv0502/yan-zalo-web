// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reactions, ThreadType } from "zca-js";
import type { ChatMessage } from "@/types/chat";
import { POST } from "./route";

const { getZaloSession, getMessageProtocol, addReaction, isCurrent } = vi.hoisted(() => ({
  getZaloSession: vi.fn(), getMessageProtocol: vi.fn(), addReaction: vi.fn(), isCurrent: vi.fn(),
}));
vi.mock("@/lib/zalo", () => ({ getZaloSession }));
vi.mock("@/lib/messageStore", () => ({ getMessageProtocol }));

const accountId = "account-one";
const key = { threadId: "shared", threadType: "User", messageId: "stored-1" } as const;
const body = { ...key, icon: Reactions.HEART };
const message: ChatMessage = {
  id: key.messageId, threadId: key.threadId, threadType: key.threadType, fromId: "sender", fromName: "Sender",
  content: "Original", ts: 55, isSelf: false,
};
const identity = { globalId: "111", cliId: "222", senderId: "sender" };
const makeRequest = (payload: unknown = body, sid = "test") => new NextRequest("http://localhost/api/chat/reaction", {
  method: "POST", body: JSON.stringify(payload), headers: { Cookie: `zalo_sid=${sid}` },
});

beforeEach(() => {
  getZaloSession.mockImplementation(sid => sid === "test" ? { api: { addReaction }, accountId, isCurrent } : null);
  getMessageProtocol.mockImplementation((account, scope) => account === accountId && scope.threadId === key.threadId
    && scope.threadType === key.threadType && scope.messageId === key.messageId ? { message, identity } : undefined);
  isCurrent.mockReturnValue(true);
  addReaction.mockResolvedValue({ msgIds: [1] });
});
afterEach(() => vi.resetAllMocks());

describe("POST /api/chat/reaction", () => {
  it("requires authentication and validates the whole selector and icon", async () => {
    expect((await POST(makeRequest(body, "invalid"))).status).toBe(401);
    expect((await POST(makeRequest(null))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, icon: { rType: 4, source: 6, icon: "No" } }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, icon: "Not a supported reaction" }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, icon: undefined }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, messageId: undefined }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, threadId: undefined }))).status).toBe(400);
    expect((await POST(makeRequest({ ...body, threadType: "Other" }))).status).toBe(400);
    expect(addReaction).not.toHaveBeenCalled();
  });

  it.each(["User", "Group"] as const)("reacts with server-owned IDs in a %s thread", async threadType => {
    getMessageProtocol.mockReturnValue({ message: { ...message, threadType }, identity });
    const response = await POST(makeRequest({ ...body, threadType, cliMsgId: "333", msgId: "555" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(addReaction).toHaveBeenCalledExactlyOnceWith(Reactions.HEART, {
      data: { msgId: "111", cliMsgId: "222" }, threadId: key.threadId, type: ThreadType[threadType],
    });
  });

  it("does not react to a source outside the authenticated scope", async () => {
    expect((await POST(makeRequest({ ...body, threadId: "other" }))).status).toBe(404);
    expect((await POST(makeRequest({ ...body, threadType: "Group" }))).status).toBe(404);
    getZaloSession.mockReturnValue({ api: { addReaction }, accountId: "other", isCurrent });
    expect((await POST(makeRequest())).status).toBe(404);
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("rejects a recalled source, legacy identifiers, and IDs the SDK would round", async () => {
    getMessageProtocol.mockReturnValueOnce({ message: { ...message, recalled: true }, identity });
    expect((await POST(makeRequest())).status).toBe(409);
    getMessageProtocol.mockReturnValueOnce({ message, identity: { ...identity, cliId: undefined } });
    expect((await POST(makeRequest({ ...body, cliMsgId: "222" }))).status).toBe(409);
    for (const globalId of ["9007199254740993", "111opaque", "0111"]) {
      getMessageProtocol.mockReturnValueOnce({ message, identity: { ...identity, globalId } });
      expect((await POST(makeRequest())).status).toBe(409);
    }
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("returns a typed upstream failure without exposing SDK detail", async () => {
    addReaction.mockRejectedValueOnce(new Error("Private upstream detail"));
    const response = await POST(makeRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Private upstream detail");
  });
});
