import { NextRequest, NextResponse } from "next/server";
import { getZaloApi } from "@/lib/zalo";
import { markRead } from "@/lib/messageStore";

export async function POST(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  const api = getZaloApi(sid);
  if (!api) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  let body: { threadId?: string; threadType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { threadId, threadType } = body;
  if (typeof threadId !== "string" || !threadId || (threadType !== "User" && threadType !== "Group")) {
    return NextResponse.json({ error: "threadId and threadType are required" }, { status: 400 });
  }

  markRead(threadId, api.getOwnId(), threadType);
  return NextResponse.json({ ok: true });
}
