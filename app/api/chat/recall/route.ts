import { NextRequest, NextResponse } from "next/server";
import { ThreadType, ZaloApiError, type API } from "zca-js";
import { getMessageProtocol } from "@/lib/messageStore";
import { getZaloSession } from "@/lib/zalo";
import type { ChatMessage } from "@/types/chat";

const REQUEST_TIMEOUT_MS = 4_000;
const RECALL_HOLD_MS = 30_000;
const MAX_RECALL_ATTEMPTS = 1_024;

type RecallStatus = "pending" | "unknown";
type RecallOutcome = RecallStatus | "rejected";
interface RecallAttempt { status: RecallStatus }

declare global {
  var __zaloChatRecallAttempts: Map<string, RecallAttempt> | undefined;
}

const attempts = globalThis.__zaloChatRecallAttempts ??= new Map();

async function untilDeadline<T>(operation: Promise<T>, deadline: number): Promise<T | undefined> {
  const timeout = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => timeout.resolve(undefined), Math.max(0, deadline - Date.now()));
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestUndo(api: API, msgId: string, cliMsgId: string, threadId: string, type: ThreadType): Promise<RecallOutcome> {
  try {
    await api.undo({ msgId, cliMsgId }, threadId, type);
    // A resolved SDK call (including its numeric status) is not a durable confirmation.
    return "pending";
  } catch (error) {
    const code: unknown = error instanceof ZaloApiError ? error.code : undefined;
    // The SDK supplies an error code for Zalo response envelopes, but not for HTTP or parse errors.
    return ((typeof code === "number" && Number.isSafeInteger(code) && code !== 0)
      || (typeof code === "string" && /^-?[1-9][0-9]*$/.test(code))) ? "rejected" : "unknown";
  }
}

function confirmed(message: ChatMessage) {
  return NextResponse.json({ status: "confirmed", message });
}

function unconfirmed(status: RecallStatus) {
  return NextResponse.json({ status }, { status: 202 });
}

export async function POST(req: NextRequest) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const session = getZaloSession(req.cookies.get("zalo_sid")?.value ?? "");
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  if (process.env.ZALO_CHAT_RECALL_VERIFIED !== "true") {
    return NextResponse.json({ error: "Message recall is unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await untilDeadline<unknown>(req.json(), deadline);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
  if (body === undefined || Date.now() >= deadline) return NextResponse.json({ error: "Request timed out" }, { status: 408 });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid recall request" }, { status: 400 });
  }
  const { threadId, threadType, messageId } = body as Record<string, unknown>;
  if (
    typeof threadId !== "string" || !threadId.trim() || (threadType !== "User" && threadType !== "Group") ||
    typeof messageId !== "string" || !messageId.trim()
  ) {
    return NextResponse.json({ error: "Invalid recall message selector" }, { status: 400 });
  }
  const { accountId } = session;
  const key = { threadId, threadType, messageId } as const;
  let source;
  try {
    source = getMessageProtocol(accountId, key);
  } catch {
    return NextResponse.json({ error: "Failed to load recall target" }, { status: 503 });
  }
  if (!source) return NextResponse.json({ error: "Recall target not found" }, { status: 404 });
  if (!source.message.isSelf || source.message.fromId !== accountId) {
    return NextResponse.json({ error: "Only your own messages can be recalled" }, { status: 403 });
  }
  if (source.message.recalled) return confirmed(source.message);
  const { globalId, cliId, senderId } = source.identity ?? {};
  if (!globalId || !cliId || senderId !== accountId) {
    return NextResponse.json({ error: "Message cannot be recalled" }, { status: 409 });
  }

  const attemptKey = JSON.stringify([accountId, threadType, threadId, globalId]);
  const existing = attempts.get(attemptKey);
  if (existing) return unconfirmed(existing.status);
  if (attempts.size >= MAX_RECALL_ATTEMPTS) return NextResponse.json({ error: "Recall is busy" }, { status: 503 });
  if (Date.now() >= deadline) return NextResponse.json({ error: "Request timed out" }, { status: 408 });

  const attempt: RecallAttempt = { status: "pending" };
  attempts.set(attemptKey, attempt);
  // The SDK call cannot be canceled. Keep the guard past the HTTP deadline, but bound its lifetime.
  const release = setTimeout(() => attempts.delete(attemptKey), RECALL_HOLD_MS);
  release.unref?.();
  const outcome = await untilDeadline(requestUndo(session.api, globalId, cliId, threadId, ThreadType[threadType]), deadline) ?? "unknown";
  attempt.status = outcome === "rejected" ? "unknown" : outcome;
  if (outcome === "rejected") {
    clearTimeout(release);
    attempts.delete(attemptKey);
  }

  if (!session.isCurrent()) return NextResponse.json({ error: "Session expired" }, { status: 401 });
  try {
    const updated = getMessageProtocol(accountId, key)?.message;
    if (updated?.recalled) return confirmed(updated);
  } catch {
    return unconfirmed("unknown");
  }
  if (outcome === "rejected") return NextResponse.json({ error: "Zalo rejected message recall" }, { status: 422 });
  return unconfirmed(outcome);
}
