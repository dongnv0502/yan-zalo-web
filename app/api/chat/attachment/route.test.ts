// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";

vi.mock("zca-js", () => ({
  ThreadType: { User: "User", Group: "Group" },
}));

vi.mock("@/lib/chatIngest", () => ({
  publishChatMessage: vi.fn(),
  saveUploadedChatMedia: vi.fn(),
}));

vi.mock("@/lib/zalo", () => ({ getZaloApi: vi.fn() }));

import { getZaloApi } from "@/lib/zalo";
import { saveUploadedChatMedia } from "@/lib/chatIngest";

function makeFile(name = "test.txt") {
  const data = name.endsWith(".png") ? Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f0AAAAASUVORK5CYII=", "base64",
  )).buffer : new ArrayBuffer(5);
  return { name, size: data.byteLength, arrayBuffer: vi.fn().mockResolvedValue(data) };
}

function makeReq(fields: { file?: unknown; threadId?: string; threadType?: string; text?: string }) {
  const mockFormData = {
    get: vi.fn((k: string) => {
      if (k === "file") return fields.file ?? null;
      if (k === "threadId") return fields.threadId ?? null;
      if (k === "threadType") return fields.threadType ?? null;
      if (k === "text") return fields.text ?? null;
      return null;
    }),
  };
  return {
    cookies: { get: (k: string) => k === "zalo_sid" ? { value: "test-sid" } : undefined },
    headers: new Headers(),
    formData: vi.fn().mockResolvedValue(mockFormData),
  } as never;
}

describe("POST /api/chat/attachment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not logged in", async () => {
    vi.mocked(getZaloApi).mockReturnValue(null);
    const res = await POST(makeReq({ file: makeFile(), threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file is provided", async () => {
    vi.mocked(getZaloApi).mockReturnValue({ sendMessage: vi.fn() } as never);
    const res = await POST(makeReq({ threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when threadId is missing", async () => {
    vi.mocked(getZaloApi).mockReturnValue({ sendMessage: vi.fn() } as never);
    const res = await POST(makeReq({ file: makeFile() }));
    expect(res.status).toBe(400);
  });

  it("calls sendMessage with attachment and returns 200 on success", async () => {
    const mockSend = vi.fn().mockResolvedValue({ message: null, attachment: [{ msgId: 1 }] });
    vi.mocked(getZaloApi).mockReturnValue({ sendMessage: mockSend, getOwnId: () => "owner" } as never);
    const res = await POST(makeReq({ file: makeFile("test.pdf"), threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "", attachments: expect.any(Array) }),
      "t-1",
      "User",
    );
  });

  it("sends text along with attachment when text field provided", async () => {
    const mockSend = vi.fn().mockResolvedValue({ message: null, attachment: [{ msgId: 2 }] });
    vi.mocked(getZaloApi).mockReturnValue({ sendMessage: mockSend, getOwnId: () => "owner" } as never);
    const res = await POST(makeReq({ file: makeFile("img.png"), threadId: "g-1", threadType: "Group", text: "Hello" }));
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Hello", attachments: expect.any(Array) }),
      "g-1",
      "Group",
    );
  });

  it("archives the outgoing image against the message ID returned by Zalo", async () => {
    vi.mocked(getZaloApi).mockReturnValue({
      getOwnId: () => "zalo-owner",
      sendMessage: vi.fn().mockResolvedValue({ message: null, attachment: [{ msgId: 123 }] }),
    } as never);
    const res = await POST(makeReq({ file: makeFile("photo.png"), threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(200);
    expect(saveUploadedChatMedia).toHaveBeenCalledWith("zalo-owner", "test-sid",
      expect.objectContaining({ id: "123", mediaType: "image", threadId: "t-1" }),
      expect.any(Buffer), "image/png", "image");
  });
});
