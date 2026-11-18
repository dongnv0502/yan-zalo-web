import { NextRequest, NextResponse } from "next/server";
import { getZaloApi } from "@/lib/zalo";
import { getMessages, getMessageAroundWindow } from "@/lib/messageStore";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  const api = getZaloApi(sid);
  if (!api) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get("threadId");

  const threadType = searchParams.get("threadType");
  if (!threadId || (threadType !== "User" && threadType !== "Group")) {
    return NextResponse.json({ error: "threadId and threadType are required" }, { status: 400 });
  }

  const around = searchParams.get("around");
  if (around !== null && !around.trim()) {
    return NextResponse.json({ error: "around must be a message ID" }, { status: 400 });
  }

  const headers = { "Cache-Control": "private, no-store" };
  try {
    const accountId = api.getOwnId();
    const result = around === null
      ? { messages: getMessages(threadId, accountId, threadType) }
      : getMessageAroundWindow(threadId, accountId, threadType, around);
    if (!result) {
      return NextResponse.json({ error: "Message not found" }, { status: 404, headers });
    }
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: "Failed to load messages" }, { status: 500, headers });
  }
}
