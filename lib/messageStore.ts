import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Conversation, ThreadType } from "@/types/chat";

declare global {
  var __chatDatabase: DatabaseSync | undefined;
}

function database(): DatabaseSync {
  if (globalThis.__chatDatabase) return globalThis.__chatDatabase;
  const filename = process.env.CHAT_DB_PATH ?? "data/chat.sqlite";
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
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
    `);
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

export function storeMessage(msg: ChatMessage, accountId: string, live = true): boolean {
  const db = database();
  const mediaKey = /^\/api\/chat\/media\/([a-f0-9]{64})$/.exec(msg.mediaUrl ?? "")?.[1] ?? null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO chat_messages (account_id, thread_type, thread_id, message_id, ts, payload, media_key)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(accountId, msg.threadType, msg.threadId, msg.id, msg.ts, JSON.stringify(msg), mediaKey);
    if (result.changes) {
      db.prepare(`
        INSERT INTO chat_conversations (account_id, thread_type, thread_id, name, unread)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET unread = unread + excluded.unread
      `).run(accountId, msg.threadType, msg.threadId,
        msg.threadType === "User" && !msg.isSelf ? msg.fromName : msg.threadId,
        live && !msg.isSelf ? 1 : 0);
    }
    db.exec("COMMIT");
    return Boolean(result.changes);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getMessages(threadId: string, accountId: string, threadType: ThreadType): ChatMessage[] {
  return database().prepare(`
    SELECT payload FROM chat_messages
    WHERE account_id = ? AND thread_type = ? AND thread_id = ?
    ORDER BY ts DESC, message_id DESC LIMIT 200
  `).all(accountId, threadType, threadId).reverse().map(row => JSON.parse(String(row.payload)));
}

export function getConversations(accountId: string): Conversation[] {
  return database().prepare(`
    SELECT c.thread_id, c.thread_type, c.name, c.avatar, c.unread, m.payload
    FROM chat_conversations c
    LEFT JOIN chat_messages m ON m.account_id = c.account_id AND m.thread_type = c.thread_type
      AND m.thread_id = c.thread_id AND m.message_id = (
        SELECT message_id FROM chat_messages WHERE account_id = c.account_id
          AND thread_type = c.thread_type AND thread_id = c.thread_id
        ORDER BY ts DESC, message_id DESC LIMIT 1
      )
    WHERE c.account_id = ? ORDER BY m.ts DESC, c.thread_type, c.thread_id
  `).all(accountId).map(row => ({
    id: String(row.thread_id), type: row.thread_type as ThreadType, name: String(row.name),
    avatar: row.avatar == null ? undefined : String(row.avatar), unread: Number(row.unread),
    lastMessage: row.payload == null ? undefined : JSON.parse(String(row.payload)),
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
    SELECT 1 FROM chat_messages WHERE account_id = ? AND media_key = ? LIMIT 1
  `).get(accountId, key));
}

export function attachChatMedia(accountId: string, msg: ChatMessage, key: string): ChatMessage | undefined {
  const row = database().prepare(`
    UPDATE chat_messages SET media_key = ?, payload = json_set(payload, '$.mediaUrl', ?, '$.mediaType', ?)
    WHERE account_id = ? AND thread_type = ? AND thread_id = ? AND message_id = ? AND media_key IS NULL
    RETURNING payload
  `).get(key, `/api/chat/media/${key}`, msg.mediaType ?? null, accountId, msg.threadType, msg.threadId, msg.id);
  return row && JSON.parse(String(row.payload));
}

export function updateMessageReaction(
  threadId: string, msgId: string, icon: string, senderId: string, senderName: string,
  accountId: string, threadType: ThreadType,
): void {
  const db = database();
  const identity = [accountId, threadType, threadId, msgId];
  const row = db.prepare(`
    SELECT payload FROM chat_messages WHERE account_id = ? AND thread_type = ? AND thread_id = ? AND message_id = ?
  `).get(...identity);
  if (!row) return;
  const msg: ChatMessage = JSON.parse(String(row.payload));
  const reactions = msg.reactions ?? [];
  const existing = reactions.find(reaction => reaction.icon === icon);
  if (existing) {
    if (existing.senderIds.includes(senderId)) return;
    existing.senderIds.push(senderId);
    existing.senderNames.push(senderName);
  } else {
    reactions.push({ icon, senderIds: [senderId], senderNames: [senderName] });
  }
  db.prepare(`
    UPDATE chat_messages SET payload = json_set(payload, '$.reactions', json(?))
    WHERE account_id = ? AND thread_type = ? AND thread_id = ? AND message_id = ?
  `).run(JSON.stringify(reactions), ...identity);
}
