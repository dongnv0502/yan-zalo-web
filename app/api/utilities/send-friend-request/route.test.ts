// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getZaloApi, isLoggedIn } from "@/lib/zalo";
import { POST } from "./route";

vi.mock("@/lib/zalo", () => ({
  getZaloApi: vi.fn(),
  isLoggedIn: vi.fn(),
}));

const sendFriendRequest = vi.fn();
const recipientUid = "9007199254740993";

function request(body: unknown, sid = "test-sid") {
  return new NextRequest("http://localhost/api/utilities/send-friend-request", {
    method: "POST",
    headers: { cookie: `zalo_sid=${sid}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isLoggedIn).mockReturnValue(true);
  vi.mocked(getZaloApi).mockReturnValue({ sendFriendRequest } as never);
  sendFriendRequest.mockResolvedValue("");
});

describe("POST /api/utilities/send-friend-request", () => {
  it("sends the greeting to the exact recipient using the active session", async () => {
    const response = await POST(request({ uid: recipientUid, message: "  Chào bạn!  " }));

    expect(response.status).toBe(200);
    expect(getZaloApi).toHaveBeenCalledWith("test-sid");
    expect(sendFriendRequest).toHaveBeenCalledExactlyOnceWith("Chào bạn!", recipientUid);
  });

  it("does not send when the Zalo session has expired", async () => {
    vi.mocked(isLoggedIn).mockReturnValue(false);

    expect((await POST(request({ uid: recipientUid }))).status).toBe(401);
    expect(sendFriendRequest).not.toHaveBeenCalled();
  });

  it.each([{ uid: 123 }, { uid: " " }, { uid: recipientUid, message: 123 }])(
    "rejects invalid input without sending: %j",
    async (body) => {
      expect((await POST(request(body))).status).toBe(400);
      expect(sendFriendRequest).not.toHaveBeenCalled();
    },
  );

  it("does not send from a plain-text form submission", async () => {
    const formRequest = request({ uid: recipientUid });
    formRequest.headers.set("content-type", "text/plain");

    expect((await POST(formRequest)).status).toBe(415);
    expect(sendFriendRequest).not.toHaveBeenCalled();
  });

  it("reports a failed send without exposing the upstream error", async () => {
    sendFriendRequest.mockRejectedValueOnce(new Error("internal upstream details"));

    const response = await POST(request({ uid: recipientUid }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Zalo không xác nhận đã gửi lời mời kết bạn." });
  });
});
