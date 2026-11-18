import { NextRequest, NextResponse } from "next/server";
import { ThreadType, type MessageContent } from "zca-js";
import { clampQuotePreviewText, readProtocolId } from "@/lib/chatProtocol";
import { commitMessage, getMessageProtocol } from "@/lib/messageStore";
import { publishSessionEvent } from "@/lib/socketServer";
import { getZaloSession } from "@/lib/zalo";
import type { ChatQuotePreview } from "@/types/chat";

function sentNotSaved() {
  return NextResponse.json({ status: "sent-not-saved" }, { status: 202 });
}

export async function POST(req: NextRequest) {
  const session = getZaloSession(req.cookies.get("zalo_sid")?.value ?? "");
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid send request" }, { status: 400 });
  }
  const { threadId, threadType, text, replyToId } = body as Record<string, unknown>;
  const content = typeof text === "string" ? text.trim() : "";
  if (
    typeof threadId !== "string" || !threadId.trim() || (threadType !== "User" && threadType !== "Group") || !content ||
    (replyToId !== undefined && (typeof replyToId !== "string" || !replyToId.trim()))
  ) {
    return NextResponse.json({ error: "Invalid threadId, threadType, text or replyToId" }, { status: 400 });
  }

  let payload: MessageContent | string = content;
  let preview: ChatQuotePreview | undefined;
  let quoteTarget: { id: string; senderId: string } | undefined;
  if (replyToId !== undefined) {
    if (process.env.ZALO_CHAT_REPLY_VERIFIED !== "true") {
      return NextResponse.json({ error: "Quoted replies are unavailable" }, { status: 503 });
    }
    let target;
    try {
      target = getMessageProtocol(session.accountId, { threadId, threadType, messageId: replyToId });
    } catch {
      return NextResponse.json({ error: "Failed to load reply target" }, { status: 503 });
    }
    if (!target) return NextResponse.json({ error: "Reply target not found" }, { status: 404 });
    if (target.message.recalled || !target.quote || typeof target.quote.content !== "string") {
      return NextResponse.json({ error: "Reply target cannot be quoted" }, { status: 409 });
    }
    payload = { msg: content, quote: target.quote };
    preview = {
      targetId: target.message.id,
      text: clampQuotePreviewText(target.quote.content),
      ...(target.message.fromName ? { fromName: target.message.fromName } : {}),
    };
    quoteTarget = { id: target.message.id, senderId: target.message.fromId };
  }

  let receipt;
  try {
    receipt = await session.api.sendMessage(payload, threadId, ThreadType[threadType]);
  } catch {
    if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
    return NextResponse.json({ error: "Failed to send message" }, { status: 502 });
  }
  if (!receipt?.message) return NextResponse.json({ error: "No message returned by Zalo" }, { status: 502 });
  if (!session.isCurrent()) return sentNotSaved();

  const id = readProtocolId(receipt.message.msgId);
  // The ACK does not establish a client message ID; a self-echo may enrich this row later.
  if (!id) return sentNotSaved();

  let committed;
  try {
    committed = commitMessage(session.accountId, {
      id, threadId, threadType, fromId: session.accountId, fromName: "Tôi", ts: Date.now(),
      content, isSelf: true, ...(preview ? { quote: preview } : {}),
    }, true, { source: "ack", identity: { globalId: id, senderId: session.accountId }, quoteTarget });
  } catch {
    return sentNotSaved();
  }
  if (!committed) return sentNotSaved();
  if (committed.changed) {
    try {
      publishSessionEvent(session, "message", committed.message);
    } catch {
      console.warn("Could not publish committed chat message");
    }
  }
  return NextResponse.json({ message: committed.message });
}
