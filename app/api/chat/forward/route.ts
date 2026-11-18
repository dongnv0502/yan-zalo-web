import { NextRequest, NextResponse } from "next/server";
import { ThreadType, type ForwardMessagePayload } from "zca-js";
import { getMessageProtocol } from "@/lib/messageStore";
import { getZaloSession } from "@/lib/zalo";

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
    return NextResponse.json({ error: "Invalid forward request" }, { status: 400 });
  }
  const { sourceThreadId, sourceThreadType, messageId, targetThreadId, targetThreadType } = body as Record<string, unknown>;
  if (
    typeof sourceThreadId !== "string" || !sourceThreadId.trim() ||
    (sourceThreadType !== "User" && sourceThreadType !== "Group") ||
    typeof messageId !== "string" || !messageId.trim() ||
    typeof targetThreadId !== "string" || !targetThreadId.trim() ||
    (targetThreadType !== "User" && targetThreadType !== "Group")
  ) {
    return NextResponse.json({ error: "Invalid source message or destination" }, { status: 400 });
  }

  let source;
  try {
    source = getMessageProtocol(session.accountId, { threadId: sourceThreadId, threadType: sourceThreadType, messageId });
  } catch {
    return NextResponse.json({ error: "Failed to load forward source" }, { status: 503 });
  }
  if (!source) return NextResponse.json({ error: "Forward source not found" }, { status: 404 });
  if (source.message.recalled || !source.message.content) {
    return NextResponse.json({ error: "Message cannot be forwarded" }, { status: 409 });
  }

  const payload: ForwardMessagePayload = { message: source.message.content };
  if (source.identity?.globalId) {
    payload.reference = { id: source.identity.globalId, ts: source.message.ts, logSrcType: 0, fwLvl: 0 };
  }
  try {
    const result = await session.api.forwardMessage(payload, [targetThreadId], ThreadType[targetThreadType]);
    if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
    if (!Array.isArray(result?.success)) return NextResponse.json({ error: "Invalid forward response from Zalo" }, { status: 502 });
    if (result.success.length === 0) return NextResponse.json({ error: "Forward failed" }, { status: 422 });
    return NextResponse.json({ success: true });
  } catch {
    if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
    return NextResponse.json({ error: "Failed to forward message" }, { status: 502 });
  }
}
