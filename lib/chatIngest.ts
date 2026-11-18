import { createHash } from "node:crypto";
import { ThreadType, type Message } from "zca-js";
import type { ChatMessage } from "@/types/chat";
import { archiveUploadedMedia, archiveZaloMedia } from "./chatMedia";
import { attachChatMedia, commitMessage, getChatMessage, hasChatMedia, markMessageRecalled } from "./messageStore";
import { publishAccountInvalidation, publishSessionEvent } from "./socketServer";
import type { ZaloSession } from "./zalo";
import { extractMessageIdentity, extractQuoteMetadata, extractQuotePreview, extractUndoTarget, hasUnverifiedHistoryUndoShape, readProtocolId } from "./chatProtocol";

const pendingMedia = new Map<string, Promise<void>>();

export function publishChatMessage(message: ChatMessage, session: ZaloSession): ChatMessage | undefined {
  if (!session.isCurrent()) return;
  const saved = commitMessage(session.accountId, message, true, {
    source: "ack", identity: { globalId: message.id, senderId: session.accountId },
  });
  if (!saved || saved.message.recalled) return;
  if (saved.changed) publishSessionEvent(session, "message", saved.message);
  return saved.message;
}

export async function ingestZaloMessage(session: ZaloSession, incoming: Message, live: boolean): Promise<{ id: string; mergedId?: string } | undefined> {
  if (!session.isCurrent()) return;
  const { accountId, api } = session;
  const { data } = incoming;
  if (hasUnverifiedHistoryUndoShape(incoming)) return;
  const identity = extractMessageIdentity(incoming);
  const upstreamId = identity?.globalId ?? identity?.cliId;
  const threadId = readProtocolId(incoming.threadId);
  if (!identity || !upstreamId || !threadId) return;

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
  if (data.msgType === "group.poll") mediaType = "poll";
  if (mediaType === "image" || mediaType === "video") {
    content = typeof fields.msg === "string" && fields.msg.trim() ? fields.msg : title.trim();
    if (!content || /^\[(ảnh|video)\]$/i.test(content)) content = mediaType === "image" ? "[Ảnh]" : "[Video]";
  }

  const timestamp = Number(data.ts);
  const message: ChatMessage = {
    id: upstreamId, threadId,
    threadType: incoming.type === ThreadType.Group ? "Group" : "User",
    fromId: identity.senderId, fromName: data.dName || identity.senderId,
    ts: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    isSelf: incoming.isSelf ?? String(data.uidFrom) === accountId,
    content,
    ...(mediaType && { mediaType }),
    ...(mediaUrl && { mediaUrl }),
  };
  if (!session.isCurrent()) return;
  message.quote = extractQuotePreview(incoming);
  const saved = commitMessage(accountId, message, live, {
    identity, source: "echo", quote: extractQuoteMetadata(incoming),
    ...(message.quote?.targetId && { quoteTarget: { id: message.quote.targetId } }),
  });
  if (!saved) return;
  if (saved.message.recalled) {
    if (saved.changed) {
      publishAccountInvalidation(session, { threadId, threadType: message.threadType, messageId: saved.message.id });
      if (saved.mergedId) publishAccountInvalidation(session, { threadId, threadType: message.threadType, messageId: saved.mergedId });
    }
    return { id: saved.message.id, mergedId: saved.mergedId };
  }
  if ((live || saved.mergedId) && saved.changed) {
    const options = saved.message.id !== message.id || saved.mergedId
      ? { mediaUpdate: true as const, mergedId: saved.mergedId } : undefined;
    publishSessionEvent(session, "message", saved.message, options);
  }

  if (sourceUrl && (mediaType === "image" || mediaType === "video")) {
    const url = sourceUrl;
    const type = mediaType;
    await saveChatMedia(session, saved.message, key => archiveZaloMedia(url, type, key));
  }
  return { id: saved.message.id, mergedId: saved.mergedId };
}

export function ingestZaloUndo(session: ZaloSession, event: unknown): void {
  if (!session.isCurrent()) return;
  const target = extractUndoTarget(event);
  if (!target) return;
  const result = markMessageRecalled(session.accountId, target);
  if (!result?.changed) return;
  if (result.hasLocalTarget !== false) publishAccountInvalidation(session, { ...target, messageId: result.messageId });
  if (result.hasLocalTarget === false || result.messageId !== target.messageId) publishAccountInvalidation(session, { ...target, namespace: "global" });
}

export async function saveUploadedChatMedia(
  session: ZaloSession, message: ChatMessage, bytes: Buffer,
  contentType: string, mediaType: "image" | "video",
): Promise<void> {
  await saveChatMedia(session, message, key => archiveUploadedMedia(bytes, contentType, mediaType, key));
}

async function saveChatMedia(
  session: ZaloSession, msg: ChatMessage, upload: (key: string) => Promise<void>,
): Promise<void> {
  const { accountId } = session;
  const key = createHash("sha256").update(JSON.stringify([accountId, msg.threadType, msg.threadId, msg.id])).digest("hex");
  const target = { threadId: msg.threadId, threadType: msg.threadType, messageId: msg.id };
  const noLongerNeeded = () => {
    if (!session.isCurrent()) return true;
    const saved = getChatMessage(accountId, target);
    return !saved || saved.recalled || hasChatMedia(accountId, key);
  };
  if (noLongerNeeded()) return;
  while (pendingMedia.has(key)) {
    const pending = pendingMedia.get(key)!;
    await pending;
    if (noLongerNeeded()) return;
  }
  // Both the send response and the Zalo socket can report the same message.
  const archive = Promise.resolve().then(async () => {
    try {
      if (noLongerNeeded()) return;
      await upload(key);
      if (!session.isCurrent()) return;
      const saved = attachChatMedia(accountId, msg, key);
      if (saved) publishSessionEvent(session, "message", saved, { mediaUpdate: true });
    } catch {
      console.warn("[chat] Không lưu được ảnh/video vào RustFS");
    }
  }).finally(() => pendingMedia.delete(key));
  pendingMedia.set(key, archive);
  await archive;
}
