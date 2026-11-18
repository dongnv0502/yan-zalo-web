import { NextRequest, NextResponse } from "next/server";
import { getZaloApi, isLoggedIn } from "@/lib/zalo";
import { getConversations, upsertConversation } from "@/lib/messageStore";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  if (!sid || !isLoggedIn(sid)) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const api = getZaloApi(sid);
  if (!api) {
    return NextResponse.json({ error: "API not ready" }, { status: 503 });
  }
  const accountId = api.getOwnId();

  const type = req.nextUrl.searchParams.get("type");
  if (type !== null && type !== "User" && type !== "Group") {
    return NextResponse.json({ error: "Invalid conversation type" }, { status: 400 });
  }

  try {
    if (type === "User") {
      const friends = await api.getAllFriends();
      for (const friend of friends) {
        const { userId, uid, id, displayName, dName, zaloName, avatar } = friend as typeof friend & {
          uid?: string; id?: string; dName?: string;
        };
        const friendId = userId ?? uid ?? id;
        if (!friendId) continue;
        upsertConversation({
          id: friendId,
          type,
          name: displayName ?? dName ?? zaloName ?? "(No name)",
          avatar: avatar ?? "",
        }, accountId);
      }
    } else if (type === "Group") {
      const groups = await api.getAllGroups();
      const groupIds = Object.keys(groups.gridVerMap ?? {});
      if (groupIds.length > 0) {
        const info = await api.getGroupInfo(groupIds);
        for (const [id, group] of Object.entries(info.gridInfoMap ?? {})) {
          const { name, avt, avatar } = group as typeof group & { avatar?: string };
          upsertConversation({ id, type, name: name ?? id, avatar: avatar ?? avt ?? "" }, accountId);
        }
      }
    }
  } catch (error) {
    console.error(`[chat/conversations] ${type} refresh failed:`, error);
    return NextResponse.json({ error: "Could not refresh conversations" }, { status: 502 });
  }

  return NextResponse.json({ conversations: getConversations(accountId, type ?? undefined) }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
