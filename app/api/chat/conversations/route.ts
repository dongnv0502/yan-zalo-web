import { NextRequest, NextResponse } from "next/server";
import { getZaloSession } from "@/lib/zalo";
import { getConversations, upsertConversation } from "@/lib/messageStore";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value ?? "";
  const session = getZaloSession(sid);
  const unauthorized = () => NextResponse.json({ error: "Not logged in" }, { status: 401 });
  if (!session) return unauthorized();
  const { api, accountId } = session;

  const type = req.nextUrl.searchParams.get("type");
  if (type !== null && type !== "User" && type !== "Group") {
    return NextResponse.json({ error: "Invalid conversation type" }, { status: 400 });
  }

  try {
    if (type === "User") {
      const friends = await api.getAllFriends();
      if (!session.isCurrent()) return unauthorized();
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
      if (!session.isCurrent()) return unauthorized();
      const groupIds = Object.keys(groups.gridVerMap ?? {});
      if (groupIds.length > 0) {
        const info = await api.getGroupInfo(groupIds);
        if (!session.isCurrent()) return unauthorized();
        for (const [id, group] of Object.entries(info.gridInfoMap ?? {})) {
          const { name, avt, avatar } = group as typeof group & { avatar?: string };
          upsertConversation({ id, type, name: name ?? id, avatar: avatar ?? avt ?? "" }, accountId);
        }
      }
    }
  } catch {
    if (!session.isCurrent()) return unauthorized();
    console.error("[chat/conversations] Không làm mới được hội thoại");
    return NextResponse.json({ error: "Could not refresh conversations" }, { status: 502 });
  }

  return NextResponse.json({ conversations: getConversations(accountId, type ?? undefined) }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
