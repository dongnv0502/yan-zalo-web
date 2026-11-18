import { NextRequest, NextResponse } from "next/server";
import { getZaloApi, isLoggedIn } from "@/lib/zalo";
import { ThreadType } from "zca-js";
import { publishChatMessage } from "@/lib/chatIngest";
import type { ChatMessage } from "@/types/chat";

export async function POST(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  if (!sid || !isLoggedIn(sid)) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const api = getZaloApi(sid);
  if (!api) {
    return NextResponse.json({ error: "API not ready" }, { status: 503 });
  }

  let body: { threadId?: string; threadType?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { threadId, threadType, text } = body;

  if (typeof threadId !== "string" || !threadId || typeof text !== "string" || !text.trim()) {
    return NextResponse.json(
      { error: "threadId and text are required" },
      { status: 400 }
    );
  }

  const isGroup = threadType === "Group";
  const zaloType = isGroup ? ThreadType.Group : ThreadType.User;

  try {
    const { message } = await api.sendMessage(text.trim(), threadId, zaloType);
    if (!message) return NextResponse.json({ error: "No message returned by Zalo" }, { status: 502 });

    const ownId = api.getOwnId();
    const sentMsg: ChatMessage = {
      id: String(message.msgId),
      threadId,
      threadType: isGroup ? "Group" : "User",
      fromId: ownId,
      fromName: "Tôi",
      content: text.trim(),
      ts: Date.now(),
      isSelf: true,
    };

    publishChatMessage(sentMsg, ownId, sid);

    return NextResponse.json({ ok: true, message: sentMsg });
  } catch {
    return NextResponse.json({ error: "Failed to send message" }, { status: 502 });
  }
}
