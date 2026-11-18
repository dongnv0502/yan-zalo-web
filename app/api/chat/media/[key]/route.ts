import { GetObjectCommand, HeadObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getRustFsStorage, isChatMediaContentType, isChatMediaKey, MAX_CHAT_MEDIA_BYTES } from "@/lib/chatMedia";
import { hasChatMedia } from "@/lib/messageStore";
import { getZaloApi } from "@/lib/zalo";

export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function mediaError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

function parseRange(header: string, contentLength: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    return { start: Math.max(0, contentLength - suffix), end: contentLength - 1 };
  }
  const start = Number(match[1]);
  if (start >= contentLength) return null;
  const end = match[2] ? Math.min(Number(match[2]), contentLength - 1) : contentLength - 1;
  return end >= start ? { start, end } : null;
}

function isMediaLength(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= MAX_CHAT_MEDIA_BYTES;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const sid = request.cookies.get("zalo_sid")?.value;
  if (!sid) return mediaError(401, "Not logged in");

  try {
    const accountId = getZaloApi(sid)?.getOwnId();
    if (!accountId) return mediaError(401, "Not logged in");

    const { key } = await params;
    if (!isChatMediaKey(key) || !hasChatMedia(accountId, key)) return mediaError(404, "Media not found");

    const { client, bucket } = getRustFsStorage();
    const object = { Bucket: bucket, Key: key };
    const options = { abortSignal: request.signal };
    const headers = new Headers({ ...privateHeaders, "Accept-Ranges": "bytes" });
    const rangeHeader = request.headers.get("range");
    let range: string | undefined;
    let expectedContentRange: string | undefined;
    let expectedLength: number | undefined;
    if (rangeHeader !== null) {
      const { ContentLength: totalLength } = await client.send(new HeadObjectCommand(object), options);
      if (!isMediaLength(totalLength)) return mediaError(502, "Unable to read chat media");
      const bounds = parseRange(rangeHeader, totalLength);
      if (!bounds) {
        headers.set("Content-Range", `bytes */${totalLength}`);
        return new Response(null, { status: 416, headers });
      }
      range = `bytes=${bounds.start}-${bounds.end}`;
      expectedContentRange = `bytes ${bounds.start}-${bounds.end}/${totalLength}`;
      expectedLength = bounds.end - bounds.start + 1;
    }

    const { Body, ContentType, ContentLength, ContentRange } = await client.send(
      new GetObjectCommand({ ...object, Range: range }), options,
    );
    if (!Body || !isChatMediaContentType(ContentType) || !isMediaLength(ContentLength) ||
        ContentRange !== expectedContentRange || (expectedLength !== undefined && ContentLength !== expectedLength)) {
      // RustFS responses use the SDK's Node.js HTTP transport. Close any body we will not serve.
      if (Body instanceof Readable) Body.destroy();
      return mediaError(502, "Unable to read chat media");
    }

    headers.set("Content-Type", ContentType);
    headers.set("Content-Length", String(ContentLength));
    headers.set("Content-Disposition", "inline");
    if (ContentRange) headers.set("Content-Range", ContentRange);
    return new Response(Body.transformToWebStream(), { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
      return mediaError(404, "Media not found");
    }
    return mediaError(502, "Unable to read chat media");
  }
}
