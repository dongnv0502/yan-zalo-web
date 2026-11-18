import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

export const MAX_CHAT_MEDIA_BYTES = 100 * 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 60_000;
const SIGNATURE_BYTES = 64;
const ZALO_CDN_DOMAINS = ["z-cdn.cloud", "zadn.vn", "zdn.vn", "zalo-cdn.com"];
const SAFE_CONTENT_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
  "image/avif": true,
  "video/mp4": true,
  "video/webm": true,
  "video/quicktime": true,
};
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const WEBM_DOCTYPE = Buffer.from("4282847765626d", "hex");
const MP4_BRANDS = /^(?:mp4[v12]|iso[m2-9]|avc1|dash|M4V |MSNV)$/;

type MediaType = "image" | "video";

declare global {
  var __chatMediaStorage: { client: S3Client; bucket: string } | undefined;
}

export function getRustFsStorage() {
  if (globalThis.__chatMediaStorage) return globalThis.__chatMediaStorage;
  const {
    RUSTFS_ENDPOINT: endpoint,
    RUSTFS_BUCKET: bucket,
    RUSTFS_ACCESS_KEY_ID: accessKeyId,
    RUSTFS_SECRET_ACCESS_KEY: secretAccessKey,
    RUSTFS_REGION: region,
  } = process.env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Chat media storage is not configured");
  }
  const client = new S3Client({
    endpoint,
    region: region || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return (globalThis.__chatMediaStorage = { client, bucket });
}

export function isChatMediaKey(key: string): boolean {
  return key.length === 64 && /^[a-f0-9]{64}$/.test(key);
}

export function isChatMediaContentType(contentType: string | undefined): contentType is string {
  return contentType !== undefined && Object.hasOwn(SAFE_CONTENT_TYPES, contentType);
}

function parseZaloCdnUrl(sourceUrl: string): URL {
  // The URL parser drops empty userinfo, so also validate the literal authority.
  if (!/^https:\/\/[^/?#\\@\s]+(?:[/?#]|$)/i.test(sourceUrl)) {
    throw new Error("Invalid Zalo media URL");
  }
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("Invalid Zalo media URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !ZALO_CDN_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error("Invalid Zalo media URL");
  }
  return url;
}

function detectContentType(prefix: Buffer): string | undefined {
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "image/jpeg";
  if (prefix.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  const gif = prefix.toString("latin1", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (prefix.toString("latin1", 0, 4) === "RIFF" && /^WEBPVP8[ LX]$/.test(prefix.toString("latin1", 8, 16))) {
    return "image/webp";
  }
  if (prefix.length >= 4 && prefix.readUInt32BE(0) === 0x1a45dfa3 && prefix.includes(WEBM_DOCTYPE, 4)) {
    return "video/webm";
  }
  if (prefix.length < 16 || prefix.toString("latin1", 4, 8) !== "ftyp") return;
  const boxSize = prefix.readUInt32BE(0);
  if (boxSize < 16 || boxSize % 4 !== 0) return;
  const majorBrand = prefix.toString("latin1", 8, 12);
  if (majorBrand === "qt  ") return "video/quicktime";
  let isMp4 = MP4_BRANDS.test(majorBrand);
  if (majorBrand === "avif" || majorBrand === "avis") return "image/avif";
  for (let offset = 16; offset + 4 <= Math.min(boxSize, prefix.length); offset += 4) {
    const compatibleBrand = prefix.toString("latin1", offset, offset + 4);
    if (compatibleBrand === "avif" || compatibleBrand === "avis") return "image/avif";
    if (MP4_BRANDS.test(compatibleBrand)) isMp4 = true;
  }
  if (isMp4) return "video/mp4";
}

function validateContentType(declaredType: string, mediaType: MediaType) {
  const mime = declaredType.split(";", 1)[0].trim().toLowerCase();
  const contentType = mime === "image/jpg" ? "image/jpeg" : mime;
  if (contentType === "" || contentType === "application/octet-stream") return undefined;
  if (!isChatMediaContentType(contentType) || !contentType.startsWith(`${mediaType}/`)) {
    throw new Error("Unsupported chat media type");
  }
  return contentType;
}

function identifyMedia(prefix: Buffer, contentType: string | undefined, mediaType: MediaType): string {
  const detectedType = detectContentType(prefix);
  if (!detectedType?.startsWith(`${mediaType}/`) || (contentType && detectedType !== contentType)) {
    throw new Error("Chat media bytes do not match the expected media type");
  }
  return detectedType;
}

export async function archiveZaloMedia(sourceUrl: string, mediaType: MediaType, key: string): Promise<void> {
  if (!isChatMediaKey(key)) throw new Error("Invalid chat media key");
  const url = parseZaloCdnUrl(sourceUrl);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), ARCHIVE_TIMEOUT_MS);
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let uploadBody: Readable | undefined;

  try {
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: abortController.signal });
    responseBody = response.body;
    if (response.status !== 200 || !responseBody || response.headers.has("content-range")) {
      throw new Error("Unable to download Zalo media");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CHAT_MEDIA_BYTES)) {
      throw new Error("Zalo media exceeds the size limit");
    }
    const declaredType = validateContentType(response.headers.get("content-type") ?? "", mediaType);
    reader = responseBody.getReader();
    const mediaReader = reader;
    let totalBytes = 0;

    async function readChunk() {
      const { done, value } = await mediaReader.read();
      if (done) return undefined;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CHAT_MEDIA_BYTES) throw new Error("Zalo media exceeds the size limit");
      return value;
    }

    const prefix = Buffer.alloc(SIGNATURE_BYTES);
    let prefixLength = 0;
    let remainder: Uint8Array | undefined;
    while (prefixLength < prefix.length) {
      const chunk = await readChunk();
      if (!chunk) break;
      const consumed = Math.min(chunk.length, prefix.length - prefixLength);
      prefix.set(chunk.subarray(0, consumed), prefixLength);
      prefixLength += consumed;
      if (consumed < chunk.length) remainder = chunk.subarray(consumed);
    }
    const sample = prefix.subarray(0, prefixLength);
    const contentType = identifyMedia(sample, declaredType, mediaType);

    async function* chunks() {
      yield sample;
      if (remainder) yield remainder;
      for (let chunk = await readChunk(); chunk; chunk = await readChunk()) yield chunk;
    }

    const { client, bucket } = getRustFsStorage();
    uploadBody = Readable.from(chunks(), { objectMode: false });
    await new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: uploadBody, ContentType: contentType },
      queueSize: 1,
      abortController,
    }).done();
  } finally {
    clearTimeout(timer);
    abortController.abort();
    uploadBody?.destroy();
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else if (responseBody) {
      await responseBody.cancel().catch(() => undefined);
    }
  }
}

export async function archiveUploadedMedia(
  bytes: Buffer,
  contentType: string,
  mediaType: MediaType,
  key: string,
): Promise<void> {
  if (!isChatMediaKey(key)) throw new Error("Invalid chat media key");
  if (bytes.length === 0 || bytes.length > MAX_CHAT_MEDIA_BYTES) throw new Error("Invalid chat media size");
  const declaredType = validateContentType(contentType, mediaType);
  const detectedType = identifyMedia(bytes.subarray(0, SIGNATURE_BYTES), declaredType, mediaType);
  const { client, bucket } = getRustFsStorage();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: detectedType,
  }), { abortSignal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
}
