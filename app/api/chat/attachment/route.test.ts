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

vi.mock("@/lib/zalo", () => ({ getZaloSession: vi.fn() }));

import { getZaloSession } from "@/lib/zalo";
import { publishChatMessage, saveUploadedChatMedia } from "@/lib/chatIngest";

function authenticate(sendMessage = vi.fn(), accountId = "owner") {
  const session = { api: { sendMessage } as never, accountId, generation: "test", isCurrent: vi.fn(() => true) };
  vi.mocked(getZaloSession).mockReturnValue(session);
  return session;
}

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
    vi.mocked(getZaloSession).mockReturnValue(null);
    const res = await POST(makeReq({ file: makeFile(), threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file is provided", async () => {
    authenticate();
    const res = await POST(makeReq({ threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when threadId is missing", async () => {
    authenticate();
    const res = await POST(makeReq({ file: makeFile() }));
    expect(res.status).toBe(400);
  });

  it("calls sendMessage with attachment and returns 200 on success", async () => {
    const mockSend = vi.fn().mockResolvedValue({ message: null, attachment: [{ msgId: 1 }] });
    authenticate(mockSend);
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
    authenticate(mockSend);
    const res = await POST(makeReq({ file: makeFile("img.png"), threadId: "g-1", threadType: "Group", text: "Hello" }));
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Hello", attachments: expect.any(Array) }),
      "g-1",
      "Group",
    );
  });

  it("archives the outgoing image against the message ID returned by Zalo", async () => {
    const session = authenticate(vi.fn().mockResolvedValue({ message: null, attachment: [{ msgId: 123 }] }), "zalo-owner");
    vi.mocked(publishChatMessage).mockImplementationOnce((message) => message);
    const res = await POST(makeReq({ file: makeFile("photo.png"), threadId: "t-1", threadType: "User" }));
    expect(res.status).toBe(200);
    expect(saveUploadedChatMedia).toHaveBeenCalledWith(session,
      expect.objectContaining({ id: "123", mediaType: "image", threadId: "t-1" }),
      expect.any(Buffer), "image/png", "image");
  });

  it("does not store or archive acknowledgments without a lossless upstream message ID", async () => {
    authenticate(vi.fn().mockResolvedValue({
      message: { msgId: Number.MAX_SAFE_INTEGER + 1 },
      attachment: [{ msgId: Number.MAX_SAFE_INTEGER + 1 }, {}],
    }));
    const res = await POST(makeReq({ file: makeFile("photo.png"), threadId: "t-1", text: "caption" }));
    expect(res.status).toBe(200);
    expect(publishChatMessage).not.toHaveBeenCalled();
    expect(saveUploadedChatMedia).not.toHaveBeenCalled();
  });

  it("does not publish an attachment acknowledged after logout", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ message: null; attachment: { msgId: number }[] }>();
    const session = authenticate(vi.fn(() => {
      started.resolve();
      return pending.promise;
    }));
    const posted = POST(makeReq({ file: makeFile("test.pdf"), threadId: "t-1" }));
    await started.promise;
    session.isCurrent.mockReturnValue(false);
    pending.resolve({ message: null, attachment: [{ msgId: 123 }] });
    expect((await posted).status).toBe(401);
    expect(publishChatMessage).not.toHaveBeenCalled();
    expect(saveUploadedChatMedia).not.toHaveBeenCalled();
  });
});
