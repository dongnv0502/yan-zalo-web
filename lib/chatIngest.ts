import { createHash } from "node:crypto";
import { ThreadType, type API, type Message } from "zca-js";
import type { ChatMessage } from "@/types/chat";
import { archiveUploadedMedia, archiveZaloMedia } from "./chatMedia";
import { attachChatMedia, hasChatMedia, storeMessage } from "./messageStore";
import { getSocketServer } from "./socketServer";

const pendingMedia = new Map<string, Promise<void>>();

export function publishChatMessage(message: ChatMessage, accountId: string, sessionId: string): void {
  if (storeMessage(message, accountId)) {
    getSocketServer()?.to(sessionId).emit("message", message);
  }
}

export async function ingestZaloMessage(api: API, sessionId: string, incoming: Message, live: boolean): Promise<void> {
  const accountId = api.getOwnId();
  const { data } = incoming;
  const upstreamId = data.msgId || data.cliMsgId;
  if (!upstreamId) return;

  const fields = typeof data.content === "object" && data.content !== null
    ? data.content as Record<string, unknown> : {};
  let content = typeof data.content === "string" ? data.content : typeof fields.msg === "string" ? fields.msg : "[media]";
  let mediaType: ChatMessage["mediaType"];
  let mediaUrl: string | undefined;
  let sourceUrl: string | undefined;
  const href = typeof fields.href === "string" ? fields.href : undefined;
  const title = typeof fields.title === "string" ? fields.title : "";

  if (data.msgType === "chat.sticker") {
    mediaType = "sticker";
    content = "[Sticker]";
    if (typeof fields.id === "number") {
      try {
        const [detail] = await api.getStickersDetail(fields.id);
        mediaUrl = detail?.stickerWebpUrl || detail?.stickerUrl || undefined;
      } catch {
        // A missing sticker preview does not prevent saving its message.
      }
    }
  } else if (data.msgType === "chat.photo" || data.msgType === "chat.gif") {
    mediaType = "image";
    sourceUrl = href ?? (typeof fields.thumb === "string" ? fields.thumb : undefined);
  } else if (data.msgType === "chat.video.msg" || (data.msgType === "share.file" && /\.(mp4|webm|mov)(?:$|[?#])/i.test(`${title || href || ""}`))) {
    mediaType = "video";
    sourceUrl = href;
  }
  if (mediaType === "image" || mediaType === "video") {
    content = typeof fields.msg === "string" && fields.msg.trim() ? fields.msg : title.trim();
    if (!content || /^\[(ảnh|video)\]$/i.test(content)) content = mediaType === "image" ? "[Ảnh]" : "[Video]";
  }

  const timestamp = Number(data.ts);
  const message: ChatMessage = {
    id: String(upstreamId), threadId: String(incoming.threadId),
    threadType: incoming.type === ThreadType.Group ? "Group" : "User",
    fromId: String(data.uidFrom ?? ""), fromName: data.dName || String(data.uidFrom ?? ""),
    ts: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    isSelf: incoming.isSelf ?? String(data.uidFrom) === accountId,
    content,
    ...(data.cliMsgId && { cliMsgId: String(data.cliMsgId) }),
    ...(mediaType && { mediaType }),
    ...(mediaUrl && { mediaUrl }),
  };
  if (live) publishChatMessage(message, accountId, sessionId);
  else storeMessage(message, accountId, false);

  if (sourceUrl && (mediaType === "image" || mediaType === "video")) {
    const url = sourceUrl;
    const type = mediaType;
    await saveChatMedia(accountId, sessionId, message, key => archiveZaloMedia(url, type, key));
  }
}

export async function saveUploadedChatMedia(
  accountId: string, sessionId: string, message: ChatMessage, bytes: Buffer,
  contentType: string, mediaType: "image" | "video",
): Promise<void> {
  await saveChatMedia(accountId, sessionId, message, key => archiveUploadedMedia(bytes, contentType, mediaType, key));
}

async function saveChatMedia(
  accountId: string, sessionId: string, msg: ChatMessage, upload: (key: string) => Promise<void>,
): Promise<void> {
  const key = createHash("sha256").update(JSON.stringify([accountId, msg.threadType, msg.threadId, msg.id])).digest("hex");
  if (hasChatMedia(accountId, key)) return;
  while (pendingMedia.has(key)) {
    const pending = pendingMedia.get(key)!;
    await pending;
    if (hasChatMedia(accountId, key)) return;
  }
  // Both the send response and the Zalo socket can report the same message.
  const archive = Promise.resolve().then(async () => {
    try {
      await upload(key);
      const saved = attachChatMedia(accountId, msg, key);
      if (saved) getSocketServer()?.to(sessionId).emit("message", saved, { mediaUpdate: true });
    } catch {
      console.warn("[chat] Không lưu được ảnh/video vào RustFS");
    }
  }).finally(() => pendingMedia.delete(key));
  pendingMedia.set(key, archive);
  await archive;
}
