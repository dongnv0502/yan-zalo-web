import { ThreadType as SdkThreadType, type SendMessageQuote } from "zca-js";
import type { ThreadType } from "@/types/chat";

export interface MessageIdentity {
  globalId?: string;
  cliId?: string;
  senderId: string;
}

interface QuotePreview {
  targetId?: string;
  text: string;
  fromName?: string;
}

interface UndoTarget {
  threadId: string;
  threadType: ThreadType;
  messageId: string;
}

const decimalDigits = /^\d+$/;
const zeroDigits = /^0+$/;
const numericString = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const previewMaxLength = 160;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function readProtocolId(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (decimalDigits.test(value)) return zeroDigits.test(value) ? undefined : value;
    return value && !/[\s\x00-\x1f\x7f]/.test(value) && !numericString.test(value) ? value : undefined;
  }
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === "bigint") return value > 0 ? String(value) : undefined;

  // Encrypted listener payloads use json-bigint. Its BigNumber marker and
  // methods are inherited; never coerce a plain wire object by String(value).
  const bigNumber = asRecord(value);
  if (bigNumber?._isBigNumber !== true || Object.hasOwn(bigNumber, "_isBigNumber") ||
    bigNumber.s !== 1 || typeof bigNumber.e !== "number" || !Number.isInteger(bigNumber.e) ||
    bigNumber.e < 0 || bigNumber.e > 308 || typeof bigNumber.isInteger !== "function" ||
    typeof bigNumber.toFixed !== "function" || !bigNumber.isInteger()) return undefined;
  // json-bigint rejects non-finite numeric literals; cap the exponent above
  // before expanding a value written in exponential notation.
  const exact: unknown = bigNumber.toFixed();
  return typeof exact === "string" && decimalDigits.test(exact) && !zeroDigits.test(exact) ? exact : undefined;
}

function messageData(message: unknown): Record<string, unknown> | undefined {
  const envelope = asRecord(message);
  if (envelope?.type !== SdkThreadType.User && envelope?.type !== SdkThreadType.Group) return undefined;
  return asRecord(envelope.data);
}

function messageIdentity(data: Record<string, unknown>): MessageIdentity | undefined {
  const senderId = readProtocolId(data.uidFrom);
  const globalId = readProtocolId(data.msgId);
  if (!globalId && data.msgId != null && data.msgId !== "" && data.msgId !== 0 && data.msgId !== "0") return undefined;
  const cliId = readProtocolId(data.cliMsgId);
  if (!senderId || (!globalId && !cliId)) return undefined;
  return { senderId, ...(globalId ? { globalId } : {}), ...(cliId ? { cliId } : {}) };
}

export function extractMessageIdentity(message: unknown): MessageIdentity | undefined {
  const data = messageData(message);
  return data && messageIdentity(data);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function extractQuoteMetadata(message: unknown): SendMessageQuote | undefined {
  const data = messageData(message);
  if (!data) return undefined;
  const { content, msgType, ttl } = data;
  if (typeof content !== "string" || content.length === 0 || (msgType !== "webchat" && msgType !== "chat.text") ||
    !safeInteger(ttl) || ttl < 0) return undefined;

  const identity = messageIdentity(data);
  const ts = readProtocolId(data.ts);
  if (!identity?.globalId || !identity.cliId || !ts || !decimalDigits.test(ts)) return undefined;

  let propertyExt: SendMessageQuote["propertyExt"];
  if (data.propertyExt !== undefined) {
    const properties = asRecord(data.propertyExt);
    if (!properties) return undefined;
    const { color, size, type, subType, ext } = properties;
    if (!safeInteger(color) || !safeInteger(size) || !safeInteger(type) || !safeInteger(subType) || typeof ext !== "string") return undefined;
    propertyExt = { color, size, type, subType, ext };
  }

  return { content, msgType, propertyExt, uidFrom: identity.senderId, msgId: identity.globalId, cliMsgId: identity.cliId, ts, ttl };
}

export function clampQuotePreviewText(value: string): string {
  if (value.length <= previewMaxLength) return value;
  const lastUnit = value.charCodeAt(previewMaxLength - 1);
  const nextUnit = value.charCodeAt(previewMaxLength);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff && nextUnit >= 0xdc00 && nextUnit <= 0xdfff;
  return value.slice(0, splitsSurrogatePair ? previewMaxLength - 1 : previewMaxLength);
}

export function extractQuotePreview(message: unknown): QuotePreview | undefined {
  const quote = asRecord(messageData(message)?.quote);
  if (typeof quote?.msg !== "string" || quote.msg.length === 0) return undefined;
  const targetId = readProtocolId(quote.globalMsgId);
  // The installed SDK does not establish that fromD is a display name, or that
  // the incoming cliMsgId can select a unique target in this conversation.
  return { ...(targetId ? { targetId } : {}), text: clampQuotePreviewText(quote.msg) };
}

// Call only for the SDK's live `undo` event, never for a history row. The SDK
// wraps history rows as GroupMessage without classifying any undo marker.
export function extractUndoTarget(event: unknown): UndoTarget | undefined {
  const envelope = asRecord(event);
  const data = asRecord(envelope?.data);
  const content = asRecord(data?.content);
  if (!envelope || !data || !content || typeof envelope.isGroup !== "boolean" || typeof envelope.isSelf !== "boolean" ||
    !Object.hasOwn(content, "deleteMsg") || !safeInteger(content.deleteMsg)) return undefined;

  const isGroup = envelope.isGroup;
  const threadId = readProtocolId(envelope.threadId);
  const messageId = readProtocolId(content.globalMsgId);
  // Undo's constructor derives the direct thread from the peer, not always
  // idTo. If the SDK wrapper and the payload disagree, do not tombstone a row.
  const expectedThreadId = readProtocolId(isGroup || envelope.isSelf ? data.idTo : data.uidFrom);
  if (!threadId || threadId !== expectedThreadId || !messageId) return undefined;
  return { threadId, threadType: isGroup ? "Group" : "User", messageId };
}

// Quarantine a suspected control envelope; this shape is not evidence to
// reconcile or persist a tombstone from HTTP group history.
export function hasUnverifiedHistoryUndoShape(message: unknown): boolean {
  const envelope = asRecord(message);
  if (envelope?.type !== SdkThreadType.Group) return false;
  const content = asRecord(asRecord(envelope.data)?.content);
  return content !== undefined && Object.hasOwn(content, "deleteMsg");
}
