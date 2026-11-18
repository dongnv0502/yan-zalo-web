import { NextRequest, NextResponse } from "next/server";
import { getZaloSession } from "@/lib/zalo";
import { ingestZaloMessage } from "@/lib/chatIngest";
import { getChatMessage } from "@/lib/messageStore";
import type { ChatMessage } from "@/types/chat";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  const session = getZaloSession(sid);
  if (!session) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const groupId = req.nextUrl.searchParams.get("groupId");
  const count = Number(req.nextUrl.searchParams.get("count") ?? "50");

  if (!groupId) {
    return NextResponse.json({ error: "Missing groupId" }, { status: 400 });
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    return NextResponse.json({ error: "count must be between 1 and 50" }, { status: 400 });
  }

  try {
    const result = await session.api.getGroupChatHistory(groupId, count);
    const upstream = (result.groupMsgs ?? []).filter(message => message.threadId === groupId);
    const importedIds = new Set<string>();
    const replacements: { id: string; mergedId: string }[] = [];
    for (let start = 0; start < upstream.length; start += 4) {
      const batch = await Promise.all(upstream.slice(start, start + 4).map(message => ingestZaloMessage(session, message, false)));
      for (const item of batch) {
        if (!item) continue;
        importedIds.add(item.id);
        if (item.mergedId) replacements.push({ id: item.id, mergedId: item.mergedId });
      }
    }
    if (!session.isCurrent()) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const committed = new Map<string, ChatMessage>();
    for (const messageId of importedIds) {
      const message = getChatMessage(session.accountId, { threadId: groupId, threadType: "Group", messageId });
      if (message) committed.set(message.id, message);
    }
    const messages = [...committed.values()].sort((left, right) => left.ts - right.ts || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
    return NextResponse.json({ messages, more: result.more, ...(replacements.length && { replacements }) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to load history" }, { status: 502 });
  }
}
