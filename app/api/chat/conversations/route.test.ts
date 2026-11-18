// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API } from "zca-js";
import { getZaloApi, isLoggedIn } from "@/lib/zalo";
import { closeMessageStore, upsertConversation } from "@/lib/messageStore";
import { GET } from "./route";

vi.mock("@/lib/zalo", () => ({ getZaloApi: vi.fn(), isLoggedIn: vi.fn() }));

const accountId = "account-1";
const makeRequest = (query = "", sid = "test-sid") => new NextRequest(
  `http://localhost/api/chat/conversations${query}`,
  { headers: { Cookie: `zalo_sid=${sid}` } },
);

beforeEach(() => vi.stubEnv("CHAT_DB_PATH", ":memory:"));
afterEach(() => {
  closeMessageStore();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/chat/conversations", () => {
  it("returns only the signed-in account's saved list without waiting on Zalo", async () => {
    const friends = Promise.withResolvers<[]>();
    const groups = Promise.withResolvers<{ gridVerMap: Record<string, string> }>();
    vi.mocked(isLoggedIn).mockImplementation((sid) => sid === "test-sid");
    vi.mocked(getZaloApi).mockReturnValue({
      getOwnId: () => accountId,
      getAllFriends: () => friends.promise,
      getAllGroups: () => groups.promise,
    } as unknown as API);
    upsertConversation({ id: "friend-1", name: "An", type: "User" }, accountId);
    upsertConversation({ id: "group-1", name: "Nhóm đã lưu", type: "Group" }, accountId);
    upsertConversation({ id: "private", name: "Tài khoản khác", type: "User" }, "account-2");

    try {
      expect((await GET(makeRequest("", "invalid-sid"))).status).toBe(401);
      // Bound the regression without measuring speed or sleeping in the passing path.
      const response = await Promise.race([GET(makeRequest()), Promise.resolve().then(() => "waiting on Zalo")]);
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) return;
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ conversations: [
        { id: "group-1", name: "Nhóm đã lưu", type: "Group", unread: 0 },
        { id: "friend-1", name: "An", type: "User", unread: 0 },
      ] });
    } finally {
      friends.resolve([]);
      groups.resolve({ gridVerMap: {} });
    }
  });

  it("refreshes each list without querying the other list and persists the result", async () => {
    vi.mocked(isLoggedIn).mockReturnValue(true);
    const getAllFriends = vi.fn().mockResolvedValue([{ userId: "friend-1", displayName: "An" }]);
    const getAllGroups = vi.fn().mockResolvedValue({ gridVerMap: { "group-1": "1" } });
    const getGroupInfo = vi.fn().mockResolvedValue({ gridInfoMap: { "group-1": { name: "Nhóm thử" } } });
    vi.mocked(getZaloApi).mockReturnValue({ getOwnId: () => accountId, getAllFriends, getAllGroups, getGroupInfo } as unknown as API);

    const direct = await GET(makeRequest("?type=User"));
    expect(await direct.json()).toEqual({ conversations: [expect.objectContaining({ id: "friend-1", type: "User", name: "An" })] });
    expect(getAllGroups).not.toHaveBeenCalled();
    const group = await GET(makeRequest("?type=Group"));
    expect(await group.json()).toEqual({ conversations: [expect.objectContaining({ id: "group-1", type: "Group", name: "Nhóm thử" })] });
    expect(getAllFriends).toHaveBeenCalledTimes(1);
    const saved = await GET(makeRequest());
    expect(await saved.json()).toEqual({ conversations: [
      expect.objectContaining({ id: "group-1" }), expect.objectContaining({ id: "friend-1" }),
    ] });
  });
});
