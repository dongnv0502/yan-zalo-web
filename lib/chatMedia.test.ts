// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveUploadedMedia,
  archiveZaloMedia,
  MAX_CHAT_MEDIA_BYTES,
} from "./chatMedia";

const { send, upload } = vi.hoisted(() => ({ send: vi.fn(), upload: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  S3Client: class { send = send; },
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(private options: { params: { Body: AsyncIterable<Uint8Array> } }) {}
    async done() {
      const chunks: Uint8Array[] = [];
      for await (const chunk of this.options.params.Body) chunks.push(chunk);
      upload({ ...this.options.params, Body: Buffer.concat(chunks) });
    }
  },
}));

const mediaKey = "a".repeat(64);
const videoUrl = "https://video.z-cdn.cloud/signed-video";
const videoBytes = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a4ioAAAAASUVORK5CYII=", "base64");
const fetchMedia = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__chatMediaStorage = undefined;
  vi.stubEnv("RUSTFS_ENDPOINT", "http://rustfs.test:9000");
  vi.stubEnv("RUSTFS_BUCKET", "chat");
  vi.stubEnv("RUSTFS_ACCESS_KEY_ID", "unit-test-access-key");
  vi.stubEnv("RUSTFS_SECRET_ACCESS_KEY", "unit-test-secret-key");
  vi.stubGlobal("fetch", fetchMedia);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("archiveZaloMedia", () => {
  it("archives streamed binary from an HTTPS Zalo CDN and detects MP4 without a file extension", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(videoBytes.subarray(0, 5));
        controller.enqueue(videoBytes.subarray(5));
        controller.close();
      },
    });
    fetchMedia.mockResolvedValue(new Response(body, { headers: { "content-type": "application/octet-stream" } }));

    await archiveZaloMedia(videoUrl, "video", mediaKey);

    expect(fetchMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: "error" }));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: "chat",
      Key: mediaKey,
      ContentType: "video/mp4",
      Body: videoBytes,
    }));
  });

  it.each(["s240-ava-talk.zadn.vn", "s120.photo.zdn.vn", "photo.zalo-cdn.com"])("archives a legacy JPEG response from %s", async (hostname) => {
    const jpegHeader = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
    fetchMedia.mockResolvedValue(new Response(jpegHeader, { headers: { "content-type": "image/jpg" } }));

    await archiveZaloMedia(`https://${hostname}/photo`, "image", mediaKey);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ ContentType: "image/jpeg" }));
  });

  it.each([
    "http://video.z-cdn.cloud/file",
    "https://video.z-cdn.cloud.attacker.test/file",
    "https://fakezadn.vn/file",
    "https://user:pass@video.z-cdn.cloud/file",
    "https://@video.z-cdn.cloud/file",
    "https://video.z-cdn.cloud:8443/file",
    "https://127.0.0.1/file",
    "https://zpsocial-fake.zaloapp.com/file",
  ])("rejects %s before issuing a request", async (sourceUrl) => {
    await expect(archiveZaloMedia(sourceUrl, "video", mediaKey)).rejects.toThrow();
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not follow redirects outside the allowed CDN", async () => {
    fetchMedia.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.test/file" } }));
    await expect(archiveZaloMedia(videoUrl, "video", mediaKey)).rejects.toThrow();
    expect(fetchMedia).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });

  it("aborts the fetch when the archive deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      fetchMedia.mockImplementation((_url, options) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = options?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      });
      const result = expect(archiveZaloMedia(videoUrl, "video", mediaKey)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["image/svg+xml", "image/png", "application/octet-stream"])("rejects active content labeled %s", async (contentType) => {
    fetchMedia.mockResolvedValue(new Response("<svg xmlns='http://www.w3.org/2000/svg' />", { headers: { "content-type": contentType } }));
    await expect(archiveZaloMedia("https://photo.zadn.vn/file.png", "image", mediaKey)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });

  it("cancels a response advertising more than 100 MiB before archiving it", async () => {
    const cancel = vi.fn();
    fetchMedia.mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      headers: {
        "content-type": "video/mp4",
        "content-length": "104857601",
      },
    }));
    expect(MAX_CHAT_MEDIA_BYTES).toBe(104857600);
    await expect(archiveZaloMedia(videoUrl, "video", mediaKey)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body even without a declared length", async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    let remaining = 100;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(videoBytes); },
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk);
        else controller.close();
      },
    });
    fetchMedia.mockResolvedValue(new Response(body, { headers: { "content-type": "video/mp4" } }));

    await expect(archiveZaloMedia(videoUrl, "video", mediaKey)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("archiveUploadedMedia", () => {
  it("stores a validated image with its canonical MIME type", async () => {
    await archiveUploadedMedia(pngBytes, "IMAGE/PNG", "image", mediaKey);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({
      Bucket: "chat",
      Key: mediaKey,
      ContentType: "image/png",
      Body: pngBytes,
    }) }), expect.anything());
  });

  it("rejects bytes inconsistent with the provided MIME type or chat media type", async () => {
    await expect(archiveUploadedMedia(pngBytes, "image/jpeg", "image", mediaKey)).rejects.toThrow();
    await expect(archiveUploadedMedia(videoBytes, "video/mp4", "image", mediaKey)).rejects.toThrow();
    await expect(archiveUploadedMedia(Buffer.alloc(0), "image/png", "image", mediaKey)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
