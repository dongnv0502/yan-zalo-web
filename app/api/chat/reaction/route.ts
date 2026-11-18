import { NextRequest, NextResponse } from "next/server";
import { Reactions, ThreadType } from "zca-js";
import { getMessageProtocol } from "@/lib/messageStore";
import { getZaloSession } from "@/lib/zalo";

const reactionIcons = new Set<unknown>(Object.values(Reactions).filter(Boolean));

function isReactionIcon(icon: unknown): icon is Reactions {
  return reactionIcons.has(icon);
}

function isSafeReactionId(id: string | undefined): id is string {
  // zca-js 2.1 uses parseInt for both IDs. Reject any value it would change or round.
  if (!id || !/^[1-9][0-9]*$/.test(id)) return false;
  return Number.isSafeInteger(Number(id));
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
    return NextResponse.json({ error: "Invalid reaction request" }, { status: 400 });
  }
  const { icon, threadId, threadType, messageId } = body as Record<string, unknown>;
  if (
    !isReactionIcon(icon) || typeof threadId !== "string" || !threadId.trim() ||
    (threadType !== "User" && threadType !== "Group") || typeof messageId !== "string" || !messageId.trim()
  ) {
    return NextResponse.json({ error: "Invalid reaction icon or message selector" }, { status: 400 });
  }

  let source;
  try {
    source = getMessageProtocol(session.accountId, { threadId, threadType, messageId });
  } catch {
    return NextResponse.json({ error: "Failed to load reaction source" }, { status: 503 });
  }
  if (!source) return NextResponse.json({ error: "Reaction source not found" }, { status: 404 });
  const { globalId, cliId } = source.identity ?? {};
  if (source.message.recalled || !isSafeReactionId(globalId) || !isSafeReactionId(cliId)) {
    return NextResponse.json({ error: "Message cannot be reacted to" }, { status: 409 });
  }

  try {
    await session.api.addReaction(icon, { data: { msgId: globalId, cliMsgId: cliId }, threadId, type: ThreadType[threadType] });
    if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
    return NextResponse.json({ success: true });
  } catch {
    if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
    return NextResponse.json({ error: "Failed to add reaction" }, { status: 502 });
  }
}
