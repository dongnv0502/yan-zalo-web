import { NextRequest, NextResponse } from "next/server";
import { getZaloApi, isLoggedIn } from "@/lib/zalo";

export async function POST(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value;
  const api = sid && isLoggedIn(sid) ? getZaloApi(sid) : null;
  if (!api) {
    return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Yêu cầu phải dùng JSON." }, { status: 415 });
  }

  const body = await req.json().catch(() => null);
  const uid = typeof body?.uid === "string" ? body.uid.trim() : "";
  if (!/^\d+$/.test(uid)) {
    return NextResponse.json({ error: "UID Zalo không hợp lệ." }, { status: 400 });
  }
  if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > 2048)) {
    return NextResponse.json({ error: "Lời nhắn phải là văn bản tối đa 2048 ký tự." }, { status: 400 });
  }

  const message = body.message?.trim() || "Xin chào, mình kết bạn nhé!";
  try {
    await api.sendFriendRequest(message, uid);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Zalo không xác nhận đã gửi lời mời kết bạn." }, { status: 502 });
  }
}
