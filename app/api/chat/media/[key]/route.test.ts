// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { send, getZaloApi, hasChatMedia } = vi.hoisted(() => ({
  send: vi.fn(),
  getZaloApi: vi.fn(),
  hasChatMedia: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  S3Client: class { send = send; },
}));
vi.mock("@/lib/zalo", () => ({ getZaloApi }));
vi.mock("@/lib/messageStore", () => ({ hasChatMedia }));

const ownedKey = "a".repeat(64);
const otherKey = "b".repeat(64);

function request(key: string, sid?: string, range?: string) {
  const headers = new Headers();
  if (sid) headers.set("Cookie", `zalo_sid=${sid}`);
  if (range) headers.set("Range", range);
  return GET(new NextRequest(`http://localhost/api/chat/media/${key}`, { headers }), {
    params: Promise.resolve({ key }),
  });
}

function storageBody(content: string) {
  return {
    transformToWebStream: () => new Response(content).body!,
    destroy: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__chatMediaStorage = undefined;
  vi.stubEnv("RUSTFS_ENDPOINT", "http://rustfs.test:9000");
  vi.stubEnv("RUSTFS_BUCKET", "chat");
  vi.stubEnv("RUSTFS_ACCESS_KEY_ID", "unit-test-access-key");
  vi.stubEnv("RUSTFS_SECRET_ACCESS_KEY", "unit-test-secret-key");
  getZaloApi.mockImplementation((sid: string) => sid === "session-2" ? { getOwnId: () => "account-1" } : null);
  hasChatMedia.mockImplementation((accountId: string, key: string) => accountId === "account-1" && key === ownedKey);
});

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/chat/media/:key", () => {
  it("rejects missing and invalid Zalo sessions without accessing storage", async () => {
    expect((await request(ownedKey)).status).toBe(401);
    expect((await request(ownedKey, "invalid-session")).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not reveal another account's media", async () => {
    const response = await request(otherKey, "session-2");
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects malformed object keys before checking ownership", async () => {
    const response = await request("A".repeat(64), "session-2");
    expect(response.status).toBe(404);
    expect(hasChatMedia).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("serves media with caching disabled using the logged-in account, not the session ID", async () => {
    send.mockResolvedValueOnce({ Body: storageBody("abcdef"), ContentType: "image/png", ContentLength: 6 });
    const response = await request(ownedKey, "session-2");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("6");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("abcdef");
  });

  it.each([
    ["bytes=2-4", "bytes 2-4/8", "cde"],
    ["bytes=5-", "bytes 5-7/8", "fgh"],
    ["bytes=-3", "bytes 5-7/8", "fgh"],
    ["bytes=5-99", "bytes 5-7/8", "fgh"],
  ])("serves %s as a seekable partial response", async (range, contentRange, content) => {
    send.mockResolvedValueOnce({ ContentLength: 8 }).mockResolvedValueOnce({
      Body: storageBody(content),
      ContentType: "video/mp4",
      ContentLength: 3,
      ContentRange: contentRange,
    });

    const objectRange = `bytes=${contentRange.split(" ")[1].split("/")[0]}`;
    const response = await request(ownedKey, "session-2", range);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Key: ownedKey, Range: objectRange }),
    }), expect.anything());
    expect(await response.text()).toBe(content);
  });

  it.each(["bytes=8-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "nonsense"])("returns the full length on an unsupported or unsatisfiable range %s", async (range) => {
    send.mockResolvedValueOnce({ ContentLength: 8 });
    const response = await request(ownedKey, "session-2", range);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */8");
    expect(await response.text()).toBe("");
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not serve unsafe MIME types even if object storage returns them", async () => {
    send.mockResolvedValueOnce({ Body: storageBody("<svg/>"), ContentLength: 6, ContentType: "image/svg+xml" });
    const response = await request(ownedKey, "session-2");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("<svg");
  });

  it("does not return raw storage errors", async () => {
    send.mockRejectedValueOnce(new Error("secret storage hostname"));
    const response = await request(ownedKey, "session-2");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret storage hostname");
  });
});
