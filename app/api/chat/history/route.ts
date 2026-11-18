import { NextRequest, NextResponse } from "next/server";
import { getZaloApi, isLoggedIn } from "@/lib/zalo";
import { ingestZaloMessage } from "@/lib/chatIngest";
import { getMessages } from "@/lib/messageStore";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  if (!sid || !isLoggedIn(sid)) {
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

  const api = getZaloApi(sid)!;

  try {
    const result = await api.getGroupChatHistory(groupId, count);
    const upstream = (result.groupMsgs ?? []).filter(message => message.threadId === groupId);
    for (let start = 0; start < upstream.length; start += 4) {
      await Promise.all(upstream.slice(start, start + 4).map(message => ingestZaloMessage(api, sid, message, false)));
    }
    const importedIds = new Set(upstream.map(({ data }) => String(data.msgId || data.cliMsgId)));
    const messages = getMessages(groupId, api.getOwnId(), "Group").filter(message => importedIds.has(message.id));
    return NextResponse.json({ messages, more: result.more }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to load history" }, { status: 502 });
  }
}
