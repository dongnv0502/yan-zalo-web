import { NextRequest, NextResponse } from "next/server";
import { getLoginStatus, getLoginError } from "@/lib/zalo";

export async function GET(req: NextRequest) {
  const sid = req.cookies.get("zalo_sid")?.value;
  if (!sid) return NextResponse.json({ status: "idle" });
  const status = getLoginStatus(sid);
  const error = status === "error" ? getLoginError(sid) : null;
  return NextResponse.json({ status, ...(error && { error }) });
}
