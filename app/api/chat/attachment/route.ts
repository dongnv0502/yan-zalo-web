import { NextRequest, NextResponse } from "next/server";
import { ThreadType, type AttachmentSource } from "zca-js";
import path from "node:path";
import sharp from "sharp";
import { getZaloSession } from "@/lib/zalo";
import { MAX_CHAT_MEDIA_BYTES } from "@/lib/chatMedia";
import { publishChatMessage, saveUploadedChatMedia } from "@/lib/chatIngest";
import { readProtocolId } from "@/lib/chatProtocol";
import type { ChatMessage } from "@/types/chat";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
};
const VIDEO_MIME_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };

export async function POST(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  const session = getZaloSession(sid);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CHAT_MEDIA_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "Attachment is too large" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  const threadId = formData.get("threadId");
  const threadType = formData.get("threadType");
  const textField = formData.get("text");
  const textContent = typeof textField === "string" ? textField.trim() : "";

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (typeof threadId !== "string" || !threadId.trim()) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  if (!file.size || file.size > MAX_CHAT_MEDIA_BYTES) {
    return NextResponse.json({ error: "Invalid attachment size" }, { status: file.size ? 413 : 400 });
  }
  const type = threadType === "Group" ? ThreadType.Group : ThreadType.User;
  const fileName = path.basename(file.name);
  const ext = path.extname(fileName).toLowerCase();
  if (!ext) return NextResponse.json({ error: "A file extension is required" }, { status: 400 });
  const imageMime = IMAGE_MIME_TYPES[ext];
  const videoMime = VIDEO_MIME_TYPES[ext];
  const bytes = Buffer.from(await file.arrayBuffer());
  const metadata: Extract<AttachmentSource, object>["metadata"] = { totalSize: bytes.length };
  if (imageMime) {
    try {
      const { width, height, format } = await sharp(bytes).metadata();
      if (!width || !height || `image/${format}` !== imageMime) throw new Error("Unexpected image format");
      Object.assign(metadata, { width, height });
    } catch {
      return NextResponse.json({ error: "Invalid image" }, { status: 400 });
    }
  }

  try {
    if (!session.isCurrent()) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const result = await session.api.sendMessage({ msg: textContent, attachments: [{
      filename: `${fileName.slice(0, -ext.length)}${ext}` as `${string}.${string}`, data: bytes, metadata,
    }] }, threadId, type);
    if (!session.isCurrent()) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { accountId } = session;
    const base = { threadId, threadType: type === ThreadType.Group ? "Group" : "User", fromId: accountId,
      fromName: "Tôi", ts: Date.now(), isSelf: true } as const;
    const textId = readProtocolId(result.message?.msgId);
    if (textId) publishChatMessage({ ...base, id: textId, content: textContent }, session);
    for (const attachment of result.attachment) {
      const id = readProtocolId(attachment.msgId);
      if (!id) continue;
      const mediaType = imageMime ? "image" : videoMime ? "video" : "file";
      const contentType = imageMime || videoMime;
      const message: ChatMessage = { ...base, id, mediaType,
        content: result.message ? fileName : textContent || fileName };
      const saved = publishChatMessage(message, session);
      if (saved && contentType && mediaType !== "file") {
        await saveUploadedChatMedia(session, saved, bytes, contentType, mediaType);
        if (!session.isCurrent()) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
      }
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to send attachment" }, { status: 502 });
  }
}
