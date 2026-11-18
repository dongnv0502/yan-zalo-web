import { NextRequest, NextResponse } from "next/server";
import { chatGraphemeSegmenter } from "@/lib/chatSearchText";
import { searchMessages } from "@/lib/messageStore";
import { getZaloApi } from "@/lib/zalo";

const headers = { "Cache-Control": "private, no-store" };

export async function POST(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  const api = getZaloApi(sid);
  if (!api) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401, headers });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400, headers });
  }

  const { threadId, threadType, q } = body as Record<string, unknown>;
  if (typeof threadId !== "string" || !threadId.trim() || (threadType !== "User" && threadType !== "Group")) {
    return NextResponse.json({ error: "threadId and threadType are required" }, { status: 400, headers });
  }
  const query = typeof q === "string" ? q.trim() : "";
  let queryLength = 0;
  for (const _grapheme of chatGraphemeSegmenter.segment(query)) {
    if (++queryLength > 200) break;
  }
  if (queryLength < 1 || queryLength > 200) {
    return NextResponse.json({ error: "q must be between 1 and 200 characters" }, { status: 400, headers });
  }

  try {
    return NextResponse.json(searchMessages(threadId, api.getOwnId(), threadType, query), { headers });
  } catch {
    return NextResponse.json({ error: "Failed to search saved messages" }, { status: 500, headers });
  }
}
