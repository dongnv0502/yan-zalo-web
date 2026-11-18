import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { ThreadType as SdkThreadType, type SendMessageQuote } from "zca-js";
import { extractQuoteMetadata, readProtocolId, type MessageIdentity } from "./chatProtocol";
import { chatGraphemeSegmenter, findChatTextSpan, foldChatText } from "@/lib/chatSearchText";
import type { ChatMessage, ChatMessageKey, ChatQuotePreview, ChatSearchResponse, Conversation, ThreadType } from "@/types/chat";

declare global {
  var __chatDatabase: DatabaseSync | undefined;
}

const SCOPE = "account_id = ? AND thread_type = ? AND thread_id = ?";
const RECALL_TEXT = "Tin nhắn đã được thu hồi";
const MEDIA_URL = /^\/api\/chat\/media\/([a-f0-9]{64})$/;
type MessageRow = Record<string, SQLOutputValue>;
type MessageScope = Pick<ChatMessageKey, "threadType" | "threadId">;

export interface CommitMessageMetadata {
  identity?: MessageIdentity;
  quote?: SendMessageQuote;
  source?: "ack" | "echo";
  /** An incoming upstream quote reference, not a browser-facing local row key. */
  quoteTarget?: { id: string; senderId?: string; kind?: "global" | "cli" };
}

function writeTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  writeTransaction(db, () => {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 2) throw new Error("Unsupported chat database schema version");
    if (version < 1) db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        account_id TEXT NOT NULL,
        thread_type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        media_key TEXT,
        PRIMARY KEY (account_id, thread_type, thread_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS chat_messages_history
        ON chat_messages (account_id, thread_type, thread_id, ts DESC, message_id DESC);
      CREATE INDEX IF NOT EXISTS chat_messages_media
        ON chat_messages (account_id, media_key) WHERE media_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS chat_conversations (
        account_id TEXT NOT NULL,
        thread_type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, thread_type, thread_id)
      );
      ALTER TABLE chat_messages ADD COLUMN quote_metadata TEXT;
      ALTER TABLE chat_messages ADD COLUMN quote_ref_id TEXT;
      ALTER TABLE chat_messages ADD COLUMN quote_ref_kind TEXT;
      ALTER TABLE chat_messages ADD COLUMN quote_ref_sender TEXT;
      CREATE INDEX chat_messages_quote_ref ON chat_messages (account_id, thread_type, thread_id, quote_ref_id)
        WHERE quote_ref_id IS NOT NULL;
      PRAGMA user_version = 1;
    `);
    if (version < 2) db.exec(`
      ALTER TABLE chat_messages ADD COLUMN protocol_global_id TEXT;
      ALTER TABLE chat_messages ADD COLUMN protocol_cli_id TEXT;
      ALTER TABLE chat_messages ADD COLUMN protocol_sender_id TEXT;
      ALTER TABLE chat_messages ADD COLUMN source TEXT;
      ALTER TABLE chat_messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX chat_messages_global_id ON chat_messages (account_id, thread_type, thread_id, protocol_global_id)
        WHERE protocol_global_id IS NOT NULL;
      CREATE INDEX chat_messages_cli_id ON chat_messages (account_id, thread_type, thread_id, protocol_cli_id, protocol_sender_id)
        WHERE protocol_cli_id IS NOT NULL;
      CREATE TABLE chat_message_tombstones (
        account_id TEXT NOT NULL,
        thread_type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_type, thread_id, message_id)
      );
      PRAGMA user_version = 2;
    `);
  });
}

function database(): DatabaseSync {
  if (globalThis.__chatDatabase) return globalThis.__chatDatabase;
  const filename = process.env.CHAT_DB_PATH ?? "data/chat.sqlite";
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    migrate(db);
    db.function("chat_text_matches", { deterministic: true }, (content, foldedQuery) =>
      typeof content === "string" && typeof foldedQuery === "string" && foldChatText(content).includes(foldedQuery) ? 1 : 0,
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return globalThis.__chatDatabase = db;
}

export function closeMessageStore(): void {
  globalThis.__chatDatabase?.close();
  globalThis.__chatDatabase = undefined;
}

function scopeParameters(accountId: string, scope: MessageScope) {
  return [accountId, scope.threadType, scope.threadId] as const;
}

function rowText(row: MessageRow | undefined, column: string): string | undefined {
  const value = row?.[column];
  return typeof value === "string" ? value : undefined;
}

function messagePayload(row: MessageRow): ChatMessage {
  return JSON.parse(String(row.payload));
}

function publicMessage(accountId: string, row: MessageRow): ChatMessage {
  const message = messagePayload(row);
  delete message.cliMsgId;
  if (!row.recalled && row.quote_metadata && process.env.ZALO_CHAT_REPLY_VERIFIED === "true") message.canReply = true;
  if (!row.recalled && row.source === "echo" && row.protocol_global_id && row.protocol_cli_id
      && row.protocol_sender_id === accountId && message.fromId === accountId && message.isSelf
      && process.env.ZALO_CHAT_RECALL_VERIFIED === "true") message.canRecall = true;
  return message;
}

function exactMessage(db: DatabaseSync, accountId: string, key: ChatMessageKey): MessageRow | undefined {
  return db.prepare(`SELECT * FROM chat_messages WHERE ${SCOPE} AND message_id = ?`)
    .get(...scopeParameters(accountId, key), key.messageId);
}

function globalMessage(db: DatabaseSync, accountId: string, key: ChatMessageKey): MessageRow | undefined {
  const parameters = scopeParameters(accountId, key);
  return db.prepare(`SELECT * FROM chat_messages WHERE ${SCOPE} AND protocol_global_id = ?`)
    .get(...parameters, key.messageId) ?? db.prepare(`
      SELECT * FROM chat_messages WHERE ${SCOPE} AND message_id = ? AND protocol_global_id IS NULL
        AND protocol_cli_id IS NULL AND json_extract(payload, '$.cliMsgId') IS NOT message_id
    `).get(...parameters, key.messageId);
}

function cliMessages(db: DatabaseSync, accountId: string, scope: MessageScope, cliId: string, senderId: string) {
  return db.prepare(`
    SELECT * FROM chat_messages WHERE ${SCOPE} AND protocol_cli_id = ? AND protocol_sender_id = ?
    UNION ALL
    SELECT * FROM chat_messages WHERE ${SCOPE} AND message_id = ? AND protocol_cli_id IS NULL
      AND protocol_global_id IS NULL AND json_extract(payload, '$.cliMsgId') = message_id
      AND json_extract(payload, '$.fromId') = ?
    LIMIT 2
  `).all(...scopeParameters(accountId, scope), cliId, senderId, ...scopeParameters(accountId, scope), cliId, senderId);
}

export function getChatMessage(accountId: string, key: ChatMessageKey): ChatMessage | undefined {
  const db = database();
  const row = exactMessage(db, accountId, key) ?? globalMessage(db, accountId, key);
  return row && publicMessage(accountId, row);
}

export function getMessageProtocol(accountId: string, key: ChatMessageKey): {
  message: ChatMessage;
  identity?: MessageIdentity;
  quote?: SendMessageQuote;
} | undefined {
  const db = database();
  const row = exactMessage(db, accountId, key) ?? globalMessage(db, accountId, key);
  if (!row) return;
  const message = publicMessage(accountId, row);
  if (row.recalled) return { message };
  const senderId = rowText(row, "protocol_sender_id");
  const globalId = rowText(row, "protocol_global_id");
  const cliId = rowText(row, "protocol_cli_id");
  const quote = rowText(row, "quote_metadata");
  return {
    message,
    ...(senderId && { identity: { senderId, ...(globalId && { globalId }), ...(cliId && { cliId }) } }),
    ...(quote && { quote: { propertyExt: undefined, ...JSON.parse(quote) } }),
  };
}

function hasTombstone(db: DatabaseSync, accountId: string, key: ChatMessageKey): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM chat_message_tombstones WHERE ${SCOPE} AND message_id = ?`)
    .get(...scopeParameters(accountId, key), key.messageId));
}

type QuoteReference = { id: string; kind: "global" | "local" | "cli"; senderId?: string };

function savedQuoteReference(row: MessageRow | undefined): QuoteReference | undefined {
  const id = rowText(row, "quote_ref_id");
  const kind = rowText(row, "quote_ref_kind");
  if (id && (kind === "global" || kind === "local" || kind === "cli")) {
    return { id, kind, senderId: rowText(row, "quote_ref_sender") };
  }
}

function resolveQuote(db: DatabaseSync, accountId: string, scope: MessageScope, preview: ChatQuotePreview,
  reference?: QuoteReference): ChatQuotePreview {
  if (!reference) return { text: preview.text, ...(preview.fromName && { fromName: preview.fromName }) };
  const key = { ...scope, messageId: reference.id };
  let target: MessageRow | undefined;
  if (reference.kind === "global") target = globalMessage(db, accountId, key);
  else if (reference.kind === "local") target = exactMessage(db, accountId, key) ?? globalMessage(db, accountId, key);
  else if (reference.senderId) {
    const candidates = cliMessages(db, accountId, scope, reference.id, reference.senderId);
    if (candidates.length === 1) target = candidates[0];
  }
  const targetId = rowText(target, "message_id") ?? (reference.kind !== "cli" ? reference.id : undefined);
  if (target?.recalled || (reference.kind === "global" && hasTombstone(db, accountId, key))
      || (reference.kind === "local" && !target && hasTombstone(db, accountId, key))) {
    return { targetId, text: RECALL_TEXT };
  }
  return { ...(targetId && { targetId }), ...(reference.kind === "global" && !target && { targetUnavailable: true }),
    text: preview.text, ...(preview.fromName && { fromName: preview.fromName }) };
}

function rewriteQuoteTargets(db: DatabaseSync, accountId: string, scope: MessageScope, messageId: string,
  globalId: string | undefined, recalled: boolean, localId?: string, cli?: { id: string; senderId: string }, mergedId?: string): void {
  const quote = recalled
    ? "json_set(payload, '$.quote', json_object('targetId', ?, 'text', ?))"
    : "json_remove(json_set(payload, '$.quote.targetId', ?), '$.quote.targetUnavailable')";
  db.prepare(`
    UPDATE chat_messages SET payload = ${quote},
      quote_ref_id = CASE WHEN quote_ref_kind = 'local' THEN ? ELSE quote_ref_id END
    WHERE ${SCOPE} AND recalled = 0 AND quote_ref_id IS NOT NULL AND (
      (quote_ref_kind = 'global' AND quote_ref_id = ?) OR
      (quote_ref_kind = 'local' AND quote_ref_id IN (?, ?)) OR
      (quote_ref_kind = 'cli' AND quote_ref_id = ? AND quote_ref_sender = ?)
    )
  `).run(...(recalled ? [messageId, RECALL_TEXT] : [messageId]), messageId, ...scopeParameters(accountId, scope),
    globalId ?? null, localId ?? null, mergedId ?? null, cli?.id ?? null, cli?.senderId ?? null);
}

function redactMessage(db: DatabaseSync, accountId: string, scope: MessageScope, row: MessageRow): MessageRow {
  const { id, threadId, threadType, fromId, fromName, ts, isSelf } = messagePayload(row);
  const payload = JSON.stringify({ id, threadId, threadType, fromId, fromName, ts, isSelf, content: RECALL_TEXT, recalled: true });
  return db.prepare(`
    UPDATE chat_messages SET payload = ?, recalled = 1, media_key = NULL, quote_metadata = NULL,
      quote_ref_id = NULL, quote_ref_kind = NULL, quote_ref_sender = NULL
    WHERE ${SCOPE} AND message_id = ? RETURNING *
  `).get(payload, ...scopeParameters(accountId, scope), id)!;
}

export function markMessageRecalled(accountId: string, target: ChatMessageKey & { senderId?: string; cliId?: string }):
  { messageId: string; changed: boolean; hasLocalTarget?: false } | undefined {
  if (!readProtocolId(target.messageId) || !readProtocolId(target.threadId)
      || (target.senderId !== undefined && !readProtocolId(target.senderId))
      || (target.cliId !== undefined && (!target.senderId || !readProtocolId(target.cliId)))) return;
  const db = database();
  return writeTransaction(db, () => {
    const parameters = scopeParameters(accountId, target);
    const { messageId: globalId, senderId, cliId } = target;
    let row = globalMessage(db, accountId, target);
    if (senderId && row && messagePayload(row).fromId !== senderId) return;
    if (cliId && row?.protocol_cli_id && row.protocol_cli_id !== cliId) return;
    if (senderId && cliId) {
      const candidates = cliMessages(db, accountId, target, cliId, senderId);
      if (candidates.length === 1) {
        const alias = candidates[0];
        if (alias.protocol_global_id && alias.protocol_global_id !== globalId) return;
        if (row && row.message_id !== alias.message_id) return;
        row = alias;
      }
    }
    const inserted = db.prepare(`INSERT INTO chat_message_tombstones VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(...parameters, globalId).changes;
    const messageId = rowText(row, "message_id") ?? globalId;
    let changed = Boolean(inserted);
    if (row && !row.recalled) {
      if (row.protocol_global_id !== globalId) db.prepare(`
        UPDATE chat_messages SET protocol_global_id = ?, protocol_cli_id = coalesce(protocol_cli_id, ?),
          protocol_sender_id = coalesce(protocol_sender_id, ?) WHERE ${SCOPE} AND message_id = ?
      `).run(globalId, cliId ?? null, senderId ?? null, ...parameters, messageId);
      redactMessage(db, accountId, target, row);
      changed = true;
    }
    const targetCliId = cliId ?? rowText(row, "protocol_cli_id");
    const targetSenderId = senderId ?? rowText(row, "protocol_sender_id");
    const cli = row && targetCliId && targetSenderId && cliMessages(db, accountId, target, targetCliId, targetSenderId).length === 1
      ? { id: targetCliId, senderId: targetSenderId } : undefined;
    if (changed) rewriteQuoteTargets(db, accountId, target, messageId, globalId, true, row ? messageId : undefined, cli);
    return { messageId, changed, ...(!row && { hasLocalTarget: false as const }) };
  });
}

function mergeReactions(message: ChatMessage, additional: ChatMessage) {
  for (const reaction of additional.reactions ?? []) {
    reaction.senderIds.forEach((senderId, index) => addReaction(message, reaction.icon, senderId, reaction.senderNames[index]));
  }
}

export function commitMessage(accountId: string, message: ChatMessage, live: boolean, meta: CommitMessageMetadata = {}):
  { message: ChatMessage; changed: boolean; mergedId?: string } | undefined {
  const globalId = readProtocolId(meta.identity?.globalId);
  const cliId = meta.source !== "ack" ? readProtocolId(meta.identity?.cliId) : undefined;
  const senderId = readProtocolId(meta.identity?.senderId);
  if ((meta.source === "ack" && !globalId) || (meta.identity && (!senderId || (!globalId && !cliId)
    || senderId !== message.fromId || (globalId ?? cliId) !== message.id))) return;

  const db = database();
  return writeTransaction(db, () => {
    const parameters = scopeParameters(accountId, message);
    const key = { threadId: message.threadId, threadType: message.threadType, messageId: message.id };
    const global = globalId ? globalMessage(db, accountId, key) : undefined;
    const aliasCandidates = cliId && senderId ? cliMessages(db, accountId, key, cliId, senderId) : [];
    // A valid global ID can identify a distinct row even if the sender reused a CLI ID.
    const candidate = aliasCandidates.length === 1 ? aliasCandidates[0] : undefined;
    const alias = globalId && candidate?.protocol_global_id && candidate.protocol_global_id !== globalId ? undefined : candidate;
    const exact = exactMessage(db, accountId, key);
    if (global && senderId && messagePayload(global).fromId !== senderId) return;
    if (global && global.protocol_cli_id && cliId && global.protocol_cli_id !== cliId) return;
    let row = alias ?? global ?? (!meta.identity ? exact : undefined);
    // A coincident raw ID is not proof that two different protocol identities match.
    if (exact && exact.message_id !== row?.message_id && exact.message_id !== global?.message_id) return;
    if (!globalId && cliId && aliasCandidates.length > 1) return;

    const canonicalId = rowText(row, "message_id") ?? message.id;
    const previous = row && publicMessage(accountId, row);
    const recalled = Boolean(row?.recalled || global?.recalled || ((globalId || !meta.identity)
      && hasTombstone(db, accountId, key)));
    if (recalled && !row) return;

    const duplicate = global && global.message_id !== canonicalId ? global : undefined;
    const mergedId = rowText(duplicate, "message_id");
    if (duplicate) db.prepare(`DELETE FROM chat_messages WHERE ${SCOPE} AND message_id = ?`)
      .run(...parameters, String(duplicate.message_id));

    const retainedGlobalId = globalId ?? rowText(row, "protocol_global_id");
    const retainedCliId = cliId ?? rowText(row, "protocol_cli_id");
    const retainedSenderId = senderId ?? rowText(row, "protocol_sender_id");
    const cli = retainedCliId && retainedSenderId && aliasCandidates.length < 2 && (!candidate || alias)
      ? { id: retainedCliId, senderId: retainedSenderId } : undefined;
    const linkChanged = rowText(row, "protocol_global_id") !== retainedGlobalId || Boolean(duplicate);
    if (recalled && row) {
      if (linkChanged) db.prepare(`UPDATE chat_messages SET protocol_global_id = ?, protocol_cli_id = ?,
        protocol_sender_id = ? WHERE ${SCOPE} AND message_id = ?`)
        .run(retainedGlobalId ?? null, retainedCliId ?? null, retainedSenderId ?? null, ...parameters, canonicalId);
      if (!row.recalled) row = redactMessage(db, accountId, key, row);
      if (linkChanged || !previous?.recalled) rewriteQuoteTargets(db, accountId, key, canonicalId, retainedGlobalId, true, canonicalId, cli, mergedId);
      return { message: publicMessage(accountId, row), changed: !previous?.recalled || linkChanged, ...(mergedId && { mergedId }) };
    }

    const saved = row && messagePayload(row);
    const alternate = duplicate && messagePayload(duplicate);
    const authoritative = meta.source === "echo" && (row?.source === "ack" || linkChanged);
    const committed: ChatMessage = { ...(saved && !authoritative ? saved : message), id: canonicalId };
    delete committed.canReply;
    delete committed.canRecall;
    delete committed.recalled;
    const mediaKey = rowText(row, "media_key") ?? rowText(duplicate, "media_key")
      ?? MEDIA_URL.exec(committed.mediaUrl ?? "")?.[1];
    const mediaType = saved?.mediaType ?? alternate?.mediaType ?? committed.mediaType;
    if (mediaType) committed.mediaType = mediaType;
    if (mediaKey) committed.mediaUrl = `/api/chat/media/${mediaKey}`;
    if (saved?.reactions) committed.reactions = saved.reactions;
    if (alternate) mergeReactions(committed, alternate);

    const target = meta.quoteTarget;
    const referenceId = readProtocolId(target?.id ?? message.quote?.targetId);
    const incomingReference: QuoteReference | undefined = referenceId ? {
      id: referenceId,
      kind: target?.kind ?? (meta.source === "ack" || (!target && meta.source !== "echo") ? "local" : "global"),
      senderId: target?.senderId,
    } : undefined;
    const savedReference = savedQuoteReference(row);
    const alternateReference = savedQuoteReference(duplicate);
    const useAlternatePreview = alternate?.quote && alternateReference?.kind === "local" && savedReference?.kind !== "local";
    const useIncomingPreview = message.quote && (!saved?.quote || meta.source === "ack"
      || (authoritative && savedReference?.kind !== "local"));
    const preview = useAlternatePreview ? alternate.quote : useIncomingPreview ? message.quote : saved?.quote ?? alternate?.quote;
    const reference = useAlternatePreview ? alternateReference : useIncomingPreview ? incomingReference
      : saved?.quote ? savedReference : alternateReference;
    if (preview) committed.quote = resolveQuote(db, accountId, key, preview, reference);
    const canonicalReferenceId = reference?.kind === "local" ? committed.quote?.targetId ?? reference.id : reference?.id;
    const validatedQuote = meta.source === "echo" && meta.quote && globalId === meta.quote.msgId && cliId === meta.quote.cliMsgId
      && senderId === meta.quote.uidFrom ? extractQuoteMetadata({ data: meta.quote, type: SdkThreadType[message.threadType] }) : undefined;
    const sdkQuote = validatedQuote ? JSON.stringify(validatedQuote) : rowText(row, "quote_metadata") ?? rowText(duplicate, "quote_metadata");
    const source = row?.source === "echo" || meta.source === "echo" ? "echo" : meta.source ?? rowText(row, "source");
    const savedRow = db.prepare(`
      INSERT INTO chat_messages (account_id, thread_type, thread_id, message_id, ts, payload, media_key,
        protocol_global_id, protocol_cli_id, protocol_sender_id, source, quote_metadata, quote_ref_id, quote_ref_kind, quote_ref_sender)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET ts = excluded.ts, payload = excluded.payload, media_key = excluded.media_key,
        protocol_global_id = excluded.protocol_global_id, protocol_cli_id = excluded.protocol_cli_id,
        protocol_sender_id = excluded.protocol_sender_id, source = excluded.source, quote_metadata = excluded.quote_metadata,
        quote_ref_id = excluded.quote_ref_id, quote_ref_kind = excluded.quote_ref_kind, quote_ref_sender = excluded.quote_ref_sender
      RETURNING *
    `).get(...parameters, canonicalId, committed.ts, JSON.stringify(committed), mediaKey ?? null, retainedGlobalId ?? null,
      retainedCliId ?? null, retainedSenderId ?? null, source ?? null, sdkQuote ?? null,
      canonicalReferenceId ?? null, reference?.kind ?? null, reference?.senderId ?? null)!;
    if (!row) db.prepare(`
      INSERT INTO chat_conversations (account_id, thread_type, thread_id, name, unread) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET unread = unread + excluded.unread
    `).run(...parameters, committed.threadType === "User" && !committed.isSelf ? committed.fromName : committed.threadId,
      live && !committed.isSelf ? 1 : 0);
    if (!row || linkChanged) rewriteQuoteTargets(db, accountId, key, canonicalId,
      retainedGlobalId ?? (!meta.identity ? canonicalId : undefined), false, canonicalId, cli, mergedId);
    const dtoRow = reference && (!row || linkChanged) ? exactMessage(db, accountId, { ...key, messageId: canonicalId }) ?? savedRow : savedRow;
    const dto = publicMessage(accountId, dtoRow);
    return { message: dto, changed: Boolean(mergedId) || !previous || JSON.stringify(dto) !== JSON.stringify(previous), ...(mergedId && { mergedId }) };
  });
}

export function storeMessage(msg: ChatMessage, accountId: string, live = true): boolean {
  return commitMessage(accountId, msg, live)?.changed ?? false;
}

export function getMessages(threadId: string, accountId: string, threadType: ThreadType): ChatMessage[] {
  return database().prepare(`
    SELECT * FROM chat_messages
    WHERE account_id = ? AND thread_type = ? AND thread_id = ?
    ORDER BY ts DESC, message_id DESC LIMIT 200
  `).all(accountId, threadType, threadId).reverse().map(row => publicMessage(accountId, row));
}

export function getMessageAroundWindow(threadId: string, accountId: string, threadType: ThreadType, messageId: string):
  { messages: ChatMessage[]; targetId: string } | undefined {
  // One statement gives the pivot and both indexed ranges the same read snapshot.
  const rows = database().prepare(`
    WITH pivot AS (
      SELECT *, 1 AS is_pivot FROM chat_messages
      WHERE account_id = $accountId AND thread_type = $threadType AND thread_id = $threadId
        AND (message_id = $messageId OR protocol_global_id = $messageId)
      ORDER BY (message_id = $messageId) DESC LIMIT 1
    ), older AS (
      SELECT *, 0 AS is_pivot FROM chat_messages
      WHERE account_id = $accountId AND thread_type = $threadType AND thread_id = $threadId
        AND (ts, message_id) < (SELECT ts, message_id FROM pivot)
      ORDER BY ts DESC, message_id DESC LIMIT 25
    ), newer AS (
      SELECT *, 0 AS is_pivot FROM chat_messages
      WHERE account_id = $accountId AND thread_type = $threadType AND thread_id = $threadId
        AND (ts, message_id) > (SELECT ts, message_id FROM pivot)
      ORDER BY ts, message_id LIMIT 25
    )
    SELECT * FROM older UNION ALL SELECT * FROM pivot UNION ALL SELECT * FROM newer
    ORDER BY ts, message_id
  `).all({ $accountId: accountId, $threadType: threadType, $threadId: threadId, $messageId: messageId });
  const pivot = rows.find(row => row.is_pivot === 1);
  if (!pivot) return;
  return { messages: rows.map(row => publicMessage(accountId, row)), targetId: String(pivot.message_id) };
}

export function getMessagesAround(threadId: string, accountId: string, threadType: ThreadType, messageId: string): ChatMessage[] | undefined {
  return getMessageAroundWindow(threadId, accountId, threadType, messageId)?.messages;
}

const SEARCH_RESULT_LIMIT = 100;
const SEARCH_EXCERPT_LIMIT = 200;

function searchExcerpt(content: string, query: string): string {
  if (content.length <= SEARCH_EXCERPT_LIMIT) return content;
  const graphemes = Array.from(chatGraphemeSegmenter.segment(content), ({ index }) => index);
  if (graphemes.length <= SEARCH_EXCERPT_LIMIT) return content;

  const match = findChatTextSpan(content, query);
  if (!match) throw new Error("Could not locate matched chat text");
  const matchStart = graphemes.indexOf(match.start);
  const matchEnd = match.end === content.length ? graphemes.length : graphemes.indexOf(match.end);
  const matchLength = matchEnd - matchStart;

  // Reserve space for both ellipses unless the match itself needs that space.
  const excerptWidth = SEARCH_EXCERPT_LIMIT - 2;
  if (matchLength > excerptWidth) return content.slice(match.start, graphemes[matchStart + SEARCH_EXCERPT_LIMIT]);
  const leadingContext = Math.floor((excerptWidth - matchLength) / 2);
  const start = Math.max(0, Math.min(matchStart - leadingContext, graphemes.length - excerptWidth));
  const end = start + excerptWidth;
  return `${start > 0 ? "…" : ""}${content.slice(graphemes[start], graphemes[end])}${end < graphemes.length ? "…" : ""}`;
}

export function searchMessages(threadId: string, accountId: string, threadType: ThreadType, query: string): ChatSearchResponse {
  const rows = database().prepare(`
    SELECT message_id, ts, json_extract(payload, '$.fromName') AS from_name, json_extract(payload, '$.content') AS content
    FROM chat_messages
    WHERE account_id = ? AND thread_type = ? AND thread_id = ?
      AND recalled = 0
      AND json_extract(payload, '$.mediaType') IS NULL
      AND json_type(payload, '$.content') = 'text'
      AND chat_text_matches(json_extract(payload, '$.content'), ?)
    ORDER BY ts DESC, message_id DESC LIMIT ?
  `).all(accountId, threadType, threadId, foldChatText(query), SEARCH_RESULT_LIMIT + 1);
  const hasMore = rows.length > SEARCH_RESULT_LIMIT;
  if (hasMore) rows.pop();
  return {
    results: rows.map(row => ({
      id: String(row.message_id), fromName: String(row.from_name), ts: Number(row.ts),
      excerpt: searchExcerpt(String(row.content), query),
    })),
    hasMore,
  };
}

export function getConversations(accountId: string, type?: ThreadType): Conversation[] {
  return database().prepare(`
    SELECT c.thread_id, c.thread_type, c.name, c.avatar, c.unread, m.payload, m.recalled, m.source,
      m.quote_metadata, m.protocol_global_id, m.protocol_cli_id, m.protocol_sender_id
    FROM chat_conversations c
    LEFT JOIN chat_messages m ON m.account_id = c.account_id AND m.thread_type = c.thread_type
      AND m.thread_id = c.thread_id AND m.message_id = (
        SELECT message_id FROM chat_messages WHERE account_id = c.account_id
          AND thread_type = c.thread_type AND thread_id = c.thread_id
        ORDER BY ts DESC, message_id DESC LIMIT 1
      )
    WHERE c.account_id = ? ${type ? "AND c.thread_type = ?" : ""}
    ORDER BY m.ts DESC, c.thread_type, c.thread_id
  `).all(...(type ? [accountId, type] : [accountId])).map(row => ({
    id: String(row.thread_id), type: row.thread_type as ThreadType, name: String(row.name),
    avatar: row.avatar == null ? undefined : String(row.avatar), unread: Number(row.unread),
    lastMessage: row.payload == null ? undefined : publicMessage(accountId, row),
  }));
}

export function upsertConversation({ id, type, name, avatar }: Pick<Conversation, "id" | "type" | "name" | "avatar">, accountId: string): void {
  database().prepare(`
    INSERT INTO chat_conversations (account_id, thread_type, thread_id, name, avatar)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name, avatar = excluded.avatar
  `).run(accountId, type, id, name, avatar ?? null);
}

export function markRead(threadId: string, accountId: string, threadType: ThreadType): void {
  database().prepare(`
    UPDATE chat_conversations SET unread = 0 WHERE account_id = ? AND thread_type = ? AND thread_id = ?
  `).run(accountId, threadType, threadId);
}

export function hasChatMedia(accountId: string, key: string): boolean {
  return Boolean(database().prepare(`
    SELECT 1 FROM chat_messages WHERE account_id = ? AND media_key = ? AND recalled = 0 LIMIT 1
  `).get(accountId, key));
}

export function attachChatMedia(accountId: string, msg: ChatMessage, key: string): ChatMessage | undefined {
  const db = database();
  return writeTransaction(db, () => {
    const target = { threadId: msg.threadId, threadType: msg.threadType, messageId: msg.id };
    const stored = exactMessage(db, accountId, target) ?? globalMessage(db, accountId, target);
    if (!stored || stored.recalled || messagePayload(stored).fromId !== msg.fromId) return;
    const row = db.prepare(`
      UPDATE chat_messages SET media_key = ?, payload = json_set(payload, '$.mediaUrl', ?, '$.mediaType', ?)
      WHERE ${SCOPE} AND message_id = ? AND media_key IS NULL AND recalled = 0 RETURNING *
    `).get(key, `/api/chat/media/${key}`, msg.mediaType ?? null, ...scopeParameters(accountId, msg), String(stored.message_id));
    return row && publicMessage(accountId, row);
  });
}

function addReaction(message: ChatMessage, icon: string, senderId: string, senderName: string): boolean {
  const reactions = message.reactions ??= [];
  const existing = reactions.find(reaction => reaction.icon === icon);
  if (existing) {
    if (existing.senderIds.includes(senderId)) return false;
    existing.senderIds.push(senderId);
    existing.senderNames.push(senderName);
  } else {
    reactions.push({ icon, senderIds: [senderId], senderNames: [senderName] });
  }
  return true;
}

export function updateMessageReaction(
  threadId: string, msgId: string, icon: string, senderId: string, senderName: string,
  accountId: string, threadType: ThreadType, targetKind?: "global",
): ChatMessage | undefined {
  const db = database();
  return writeTransaction(db, () => {
    const target = { threadId, threadType, messageId: msgId };
    const row = (targetKind !== "global" ? exactMessage(db, accountId, target) : undefined) ?? globalMessage(db, accountId, target);
    if (!row || row.recalled) return;
    const message = publicMessage(accountId, row);
    if (!addReaction(message, icon, senderId, senderName)) return;
    db.prepare(`
      UPDATE chat_messages SET payload = json_set(payload, '$.reactions', json(?))
      WHERE ${SCOPE} AND message_id = ? AND recalled = 0
    `).run(JSON.stringify(message.reactions), ...scopeParameters(accountId, target), message.id);
    return message;
  });
}
