// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API } from "zca-js";
import { closeMessageStore, storeMessage } from "@/lib/messageStore";
import { getZaloApi } from "@/lib/zalo";
import type { ChatMessage } from "@/types/chat";
import { GET } from "./route";

vi.mock("@/lib/zalo", () => ({ getZaloApi: vi.fn() }));

const accountId = "account-one";
const selector = "threadId=shared&threadType=User";
const makeRequest = (query: string, sid = "test-sid") => new NextRequest(
  `http://localhost/api/chat/messages?${query}`, { headers: { Cookie: `zalo_sid=${sid}` } },
);
const message: ChatMessage = {
  id: "pivot", threadId: "shared", threadType: "User", fromId: "sender", fromName: "An",
  ts: 5, content: "Saved message", isSelf: false,
};

beforeEach(() => {
  vi.stubEnv("CHAT_DB_PATH", ":memory:");
  vi.mocked(getZaloApi).mockImplementation(sid => sid === "test-sid" ? { getOwnId: () => accountId } as API : null);
});
afterEach(() => {
  closeMessageStore();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/chat/messages", () => {
  it("requires the session for a window request", async () => {
    expect((await GET(makeRequest(`${selector}&around=pivot`, "invalid"))).status).toBe(401);
  });

  it.each(["around=pivot", "threadId=shared&threadType=Other&around=pivot", `${selector}&around=`])(
    "rejects an invalid window selector: %s", async query => {
      expect((await GET(makeRequest(query))).status).toBe(400);
    },
  );

  it("returns 404 when the pivot is only saved in other scopes", async () => {
    storeMessage(message, "account-two");
    storeMessage({ ...message, threadType: "Group" }, accountId);
    storeMessage({ ...message, threadId: "other" }, accountId);

    const response = await GET(makeRequest(`${selector}&around=pivot`));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns a private chronological window and preserves the latest contract", async () => {
    storeMessage(message, accountId);
    for (let index = 0; index < 203; index++) {
      storeMessage({ ...message, id: `new-${index}`, ts: index + 6 }, accountId);
    }

    const latest = await GET(makeRequest(selector));
    expect(latest.status).toBe(200);
    expect(latest.headers.get("Cache-Control")).toBe("private, no-store");
    const latestBody = await latest.json();
    expect(Object.keys(latestBody)).toEqual(["messages"]);
    expect(latestBody.messages).toHaveLength(200);
    expect(latestBody.messages[0].id).toBe("new-3");

    const response = await GET(makeRequest(`${selector}&around=pivot`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      targetId: "pivot",
      messages: [message, ...Array.from({ length: 25 }, (_, index) => ({ ...message, id: `new-${index}`, ts: index + 6 }))],
    });
  });
});
