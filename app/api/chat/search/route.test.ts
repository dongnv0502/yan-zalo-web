// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API } from "zca-js";
import { closeMessageStore, storeMessage } from "@/lib/messageStore";
import { getZaloApi } from "@/lib/zalo";
import type { ChatMessage } from "@/types/chat";
import { POST } from "./route";

vi.mock("@/lib/zalo", () => ({ getZaloApi: vi.fn() }));

const accountId = "account-one";
const makeRequest = (body: string, sid = "test-sid") => new NextRequest("http://localhost/api/chat/search", {
  method: "POST", body, headers: { "Content-Type": "application/json", Cookie: `zalo_sid=${sid}` },
});
const query = { threadId: "shared", threadType: "User", q: "  ĐỔI %_  " };

beforeEach(() => {
  vi.stubEnv("CHAT_DB_PATH", ":memory:");
  vi.mocked(getZaloApi).mockImplementation(sid => sid === "test-sid" ? { getOwnId: () => accountId } as API : null);
});
afterEach(() => {
  closeMessageStore();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/chat/search", () => {
  it("requires a valid session cookie", async () => {
    const response = await POST(makeRequest(JSON.stringify(query), "invalid"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ ...query, threadId: " " }),
    JSON.stringify({ ...query, threadType: "Community" }),
    JSON.stringify({ ...query, q: 12 }),
    JSON.stringify({ ...query, q: " \t " }),
    JSON.stringify({ ...query, q: "x".repeat(201) }),
  ])("rejects an invalid search body: %s", async body => {
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("accepts a 200-character query after trimming and keeps empty results private", async () => {
    const response = await POST(makeRequest(JSON.stringify({ ...query, q: ` ${"x".repeat(200)} ` })));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ results: [], hasMore: false });
  });

  it("returns a scoped excerpt DTO using the session account, not a supplied account", async () => {
    const message: ChatMessage = {
      id: "original", threadId: "shared", threadType: "User", fromId: "sender", fromName: "An",
      ts: 5, content: "Đổi %_ ngay", isSelf: false, cliMsgId: "private-protocol-id",
    };
    storeMessage(message, accountId);
    storeMessage({ ...message, id: "other-type", threadType: "Group" }, accountId);
    storeMessage({ ...message, id: "other-thread", threadId: "other" }, accountId);
    storeMessage({ ...message, id: "other-account" }, "account-two");

    const response = await POST(makeRequest(JSON.stringify({ ...query, accountId: "account-two" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      results: [{ id: "original", fromName: "An", ts: 5, excerpt: "Đổi %_ ngay" }],
      hasMore: false,
    });
  });
});
