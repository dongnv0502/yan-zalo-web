// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types/chat";
import {
  attachChatMedia, closeMessageStore, commitMessage, getChatMessage, getConversations, getMessageAroundWindow,
  getMessageProtocol, getMessages, getMessagesAround, hasChatMedia, markMessageRecalled,
  searchMessages, storeMessage, updateMessageReaction,
} from "./messageStore";

it("reopens the database with deduplicated history isolated by account and thread type", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yan-chat-test-"));
  vi.stubEnv("CHAT_DB_PATH", join(dir, "chat.sqlite"));
  const message: ChatMessage = {
    id: "m1", threadId: "shared", threadType: "User", fromId: "sender", fromName: "Alice",
    ts: 1000, content: "A private message", isSelf: false,
  };
  try {
    // Reload the module to verify retrieval after reopening the database.
    const writer = await import("./messageStore");
    writer.storeMessage(message, "account-one");
    writer.storeMessage({ ...message, content: "Duplicate delivery" }, "account-one");
    writer.storeMessage({ ...message, threadType: "Group", content: "Group message" }, "account-one", false);
    writer.markRead("shared", "account-one", "User");
    writer.closeMessageStore();
    vi.resetModules();
    const reader = await import("./messageStore");
    try {
      expect(reader.getMessages("shared", "account-one", "User")).toEqual([message]);
      expect(reader.getMessages("shared", "account-two", "User")).toEqual([]);
      expect(reader.getMessages("shared", "account-one", "Group")).toMatchObject([{ content: "Group message" }]);
      expect(reader.getConversations("account-one")).toMatchObject([{ unread: 0 }, { unread: 0 }]);
    } finally {
      reader.closeMessageStore();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("saved conversation search and navigation", () => {
  const accountId = "account-one";
  const threadId = "shared";
  const save = (id: string, content: string, overrides: Partial<ChatMessage> = {}, account = accountId) => {
    storeMessage({
      id, threadId, threadType: "User", fromId: "sender", fromName: "Alice",
      ts: 1000, content, isSelf: false, ...overrides,
    }, account, false);
  };

  beforeEach(() => vi.stubEnv("CHAT_DB_PATH", ":memory:"));
  afterEach(() => {
    closeMessageStore();
    vi.unstubAllEnvs();
  });

  it("searches beyond the most recent 200 messages for literal, accent-sensitive text", () => {
    const original = "ĐỔI %_ MẬT KHẨU";
    save("old", original, { ts: 1 });
    for (let index = 0; index < 205; index++) save(`filler-${index}`, "Đổi xa mật khẩu");
    save("other-type", original, { threadType: "Group" });
    save("other-thread", original, { threadId: "another" });
    save("other-account", original, {}, "account-two");
    save("media", original, { mediaType: "file" });
    save("metadata", "Nonmatching content", { fromName: original, mediaUrl: original });

    expect(getMessages(threadId, accountId, "User").map(({ id }) => id)).not.toContain("old");
    expect(searchMessages(threadId, accountId, "User", "đổi %_ mật khẩu")).toEqual({
      results: [{ id: "old", fromName: "Alice", ts: 1, excerpt: original }],
      hasMore: false,
    });
    expect(searchMessages(threadId, accountId, "User", "doi %_")).toEqual({ results: [], hasMore: false });
  });

  it("returns only the 100 newest matches in SQLite binary order and detects one more", () => {
    for (let index = 0; index < 98; index++) save(`m-${String(index).padStart(2, "0")}`, "target", { ts: 1 });
    // Insertion order and locale collation would both disagree with the stored order.
    for (const id of ["a", "Z", "é"]) save(id, "target");

    const { results, hasMore } = searchMessages(threadId, accountId, "User", "target");
    expect(results).toHaveLength(100);
    expect(results.slice(0, 3).map(({ id }) => id)).toEqual(["é", "a", "Z"]);
    expect(results.at(-1)?.id).toBe("m-01");
    expect(hasMore).toBe(true);
    expect(getMessages(threadId, accountId, "User").at(-1)?.id).toBe("é");
    expect(getConversations(accountId)[0]?.lastMessage?.id).toBe("é");
  });

  it("centers excerpts on original graphemes when folding changes string length", () => {
    const family = "👨‍👩‍👧‍👦";
    const original = "ĐỔI";
    save("old", `${"İ".repeat(260)} ${family} ${original} ${family} ${"x".repeat(260)}`);

    const { results } = searchMessages(threadId, accountId, "User", "đổi");
    expect(results).toHaveLength(1);
    const excerpt = results[0].excerpt;
    expect(excerpt).toMatch(/^….*…$/u);
    expect(excerpt).toContain(`${family} ${original} ${family}`);
    expect(Array.from(new Intl.Segmenter().segment(excerpt)).length).toBeLessThanOrEqual(200);

    save("expands", `${"x".repeat(260)} İ ${"x".repeat(260)}`);
    expect(searchMessages(threadId, accountId, "User", "i̇").results.find(({ id }) => id === "expands")?.excerpt)
      .toContain("x İ x");

    const longestQuery = "Q".repeat(200);
    save("full-match", `${"x".repeat(260)}${longestQuery}${"x".repeat(260)}`);
    expect(searchMessages(threadId, accountId, "User", longestQuery).results[0]?.excerpt).toBe(longestQuery);
  });

  it("opens an old pivot with at most 25 rows on each side including timestamp ties", () => {
    const ids = Array.from({ length: 255 }, (_, index) => `m-${String(index).padStart(3, "0")}`);
    for (const id of ids.toReversed()) save(id, id);
    save(ids[30], "Wrong type", { threadType: "Group" });
    save(ids[30], "Wrong account", {}, "account-two");
    save("only-in-group", "Group only", { threadType: "Group" });

    expect(getMessages(threadId, accountId, "User").map(({ id }) => id)).not.toContain(ids[30]);
    const window = getMessagesAround(threadId, accountId, "User", ids[30]);
    expect(window?.map(({ id }) => id)).toEqual(ids.slice(5, 56));
    expect(window?.[25]?.content).toBe(ids[30]);
    expect(getMessagesAround(threadId, accountId, "User", ids[0])?.map(({ id }) => id)).toEqual(ids.slice(0, 26));
    expect(getMessagesAround(threadId, accountId, "User", "only-in-group")).toBeUndefined();
  });
});

describe("committed message lifecycle", () => {
  const accountId = "owner";
  const scope = { threadType: "Group", threadId: "shared" } as const;
  const key = (messageId: string) => ({ ...scope, messageId });
  const original: ChatMessage = {
    ...scope, id: "950000000000000002", content: "Original confidential text", ts: 1,
    fromId: accountId, fromName: "Alice", isSelf: true,
  };
  const identity = { senderId: accountId, globalId: original.id, cliId: "cli-1" };
  const quote = {
    content: original.content, msgType: "webchat", propertyExt: undefined,
    uidFrom: accountId, msgId: original.id, cliMsgId: "cli-1", ts: "1", ttl: 0,
  };
  const echo = { source: "echo", identity, quote } as const;
  const ack = { source: "ack", identity: { senderId: accountId, globalId: original.id } } as const;
  const mediaKey = "a".repeat(64);
  const recallText = "Tin nhắn đã được thu hồi";

  beforeEach(() => {
    vi.stubEnv("CHAT_DB_PATH", ":memory:");
    vi.stubEnv("ZALO_CHAT_REPLY_VERIFIED", "true");
    vi.stubEnv("ZALO_CHAT_RECALL_VERIFIED", "true");
  });
  afterEach(() => {
    closeMessageStore();
    vi.unstubAllEnvs();
  });

  function withLegacyDatabase(run: (filename: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "yan-chat-migration-"));
    const filename = join(dir, "chat.sqlite");
    vi.stubEnv("CHAT_DB_PATH", filename);
    try {
      const legacy = new DatabaseSync(filename);
      try {
        legacy.exec(`CREATE TABLE chat_messages (
          account_id TEXT NOT NULL, thread_type TEXT NOT NULL, thread_id TEXT NOT NULL,
          message_id TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL, media_key TEXT,
          PRIMARY KEY (account_id, thread_type, thread_id, message_id)
        )`);
        legacy.prepare("INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?, NULL)")
          .run(accountId, scope.threadType, scope.threadId, original.id, original.ts, JSON.stringify(original));
      } finally {
        legacy.close();
      }
      run(filename);
    } finally {
      closeMessageStore();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("upgrades a legacy SQLite file, retains its chat, and reopens enriched protocol data without exposing it", () => {
    withLegacyDatabase(() => {
      expect(getMessageProtocol(accountId, key(original.id))).toEqual({ message: original });
      expect(commitMessage(accountId, original, false, echo)?.message).toEqual({
        ...original, canReply: true, canRecall: true,
      });
      closeMessageStore();
      const committed = getMessageProtocol(accountId, key(original.id));
      expect(committed?.quote).toMatchObject(quote);
      expect(committed?.identity).toEqual(identity);
      expect(getMessages(scope.threadId, accountId, scope.threadType)).toEqual([committed?.message]);
      expect(getMessageProtocol("somebody-else", key(original.id))).toBeUndefined();
      expect(getMessageProtocol(accountId, { ...key(original.id), threadType: "User" })).toBeUndefined();
      expect(committed?.message).not.toHaveProperty("msgId");
      expect(committed?.message).not.toHaveProperty("propertyExt");
      vi.stubEnv("ZALO_CHAT_REPLY_VERIFIED", "True");
      vi.stubEnv("ZALO_CHAT_RECALL_VERIFIED", "1");
      expect(getChatMessage(accountId, key(original.id))).toEqual(original);
    });
  });

  it("rolls back schema changes when an error interrupts migration and can then retry", () => {
    withLegacyDatabase(filename => {
      const collision = new DatabaseSync(filename);
      try {
        collision.exec("CREATE VIEW chat_message_tombstones AS SELECT 1 AS incompatible");
      } finally {
        collision.close();
      }
      expect(() => getMessages(scope.threadId, accountId, scope.threadType)).toThrow();
      const inspect = new DatabaseSync(filename);
      try {
        expect(inspect.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
        expect(inspect.prepare("PRAGMA table_info(chat_messages)").all().map(row => row.name)).toEqual([
          "account_id", "thread_type", "thread_id", "message_id", "ts", "payload", "media_key",
        ]);
        inspect.exec("DROP VIEW chat_message_tombstones");
      } finally {
        inspect.close();
      }
      expect(getMessages(scope.threadId, accountId, scope.threadType)).toEqual([original]);
    });
  });

  it.each(["ack first", "echo first"])("reconciles %s without losing server content, a saved preview, media, or reactions", order => {
    storeMessage({ ...original, id: "parent", content: "Parent" }, accountId, false);
    const acknowledgment = { ...original, content: "ACK approximation", quote: { targetId: "parent", text: "Parent" } };
    if (order === "ack first") {
      expect(commitMessage(accountId, acknowledgment, true, ack)?.message.canRecall).toBeUndefined();
    } else {
      expect(commitMessage(accountId, original, true, echo)?.changed).toBe(true);
    }
    expect(attachChatMedia(accountId, { ...original, mediaType: "image" }, mediaKey)?.mediaUrl)
      .toBe(`/api/chat/media/${mediaKey}`);
    updateMessageReaction(scope.threadId, original.id, "heart", "reactor", "Bob", accountId, scope.threadType);
    if (order === "ack first") commitMessage(accountId, original, true, echo);
    else commitMessage(accountId, acknowledgment, true, ack);
    expect(getChatMessage(accountId, key(original.id))).toMatchObject({
      content: original.content, quote: acknowledgment.quote, mediaUrl: `/api/chat/media/${mediaKey}`,
      reactions: [{ icon: "heart", senderIds: ["reactor"], senderNames: ["Bob"] }], canReply: true, canRecall: true,
    });
    expect(commitMessage(accountId, original, true, echo)?.changed).toBe(false);
    expect(getMessages(scope.threadId, accountId, scope.threadType)).toHaveLength(2);
    expect(getConversations(accountId)[0]?.unread).toBe(0);
  });

  it("rejects a non-exact ACK and does not infer capabilities from flattened text or a CLI-only echo", () => {
    expect(commitMessage(accountId, { ...original, id: String(Number(original.id)) }, true, { source: "ack" })).toBeUndefined();
    const cliOnly = { ...original, id: identity.cliId, mediaType: "image" } as const;
    const partial = { source: "echo", identity: { senderId: accountId, cliId: identity.cliId } } as const;
    expect(commitMessage(accountId, cliOnly, true, partial)?.message).toEqual(cliOnly);
    expect(commitMessage(accountId, { ...cliOnly, id: original.id }, true, { source: "echo", identity })?.message)
      .toMatchObject({ id: identity.cliId, canRecall: true });
    expect(getChatMessage(accountId, key(original.id))?.id).toBe(identity.cliId);
    expect(getMessages(scope.threadId, accountId, scope.threadType)).toHaveLength(1);
  });

  it("confines CLI matching to the sender and declines an ambiguous CLI-only quote link", () => {
    const one = { ...original, fromId: "sender-one", isSelf: false };
    const two = { ...one, id: "second-global", fromId: "sender-two" };
    const three = { ...one, id: "third-global" };
    for (const message of [one, two, three]) {
      expect(commitMessage(accountId, message, true, { source: "echo", identity: {
        globalId: message.id, cliId: identity.cliId, senderId: message.fromId,
      } })?.message.id).toBe(message.id);
    }
    const reply = { ...original, id: "reply", quote: { text: "A readable excerpt" } };
    const storeReply = (id: string, senderId: string) => commitMessage(accountId, { ...reply, id }, false, {
      quoteTarget: { id: identity.cliId, kind: "cli", senderId },
    });
    expect(storeReply("unique-reply", two.fromId)?.message.quote?.targetId).toBe(two.id);
    expect(storeReply("ambiguous-reply", one.fromId)?.message.quote?.targetId).toBeUndefined();
    expect(markMessageRecalled(accountId, key(two.id))?.changed).toBe(true);
    expect(getChatMessage(accountId, key("unique-reply"))?.quote).toEqual({ targetId: two.id, text: recallText });
    expect(getChatMessage(accountId, key(one.id))?.content).toBe(original.content);
  });

  it("does not mark flattened media or a mismatched quote identity as quotable", () => {
    const media = { ...original, mediaType: "image" } as const;
    expect(commitMessage(accountId, media, true, { ...echo, quote: { ...quote, content: { msg: media.content } } })?.message)
      .toMatchObject({ canRecall: true });
    expect(getMessageProtocol(accountId, key(original.id))?.quote).toBeUndefined();
    expect(commitMessage(accountId, media, true, { ...echo, quote: { ...quote, msgId: "another-message" } })?.message.canReply)
      .toBeUndefined();
  });

  it("redacts the saved row, scoped replies, search, conversation preview and delayed media or reactions", () => {
    const aliasedMessage = { ...original, id: identity.cliId, cliMsgId: identity.cliId };
    storeMessage(aliasedMessage, accountId);
    attachChatMedia(accountId, { ...aliasedMessage, mediaType: "image" }, mediaKey);
    updateMessageReaction(scope.threadId, aliasedMessage.id, "heart", "reactor", "Bob", accountId, scope.threadType);
    const reply = { ...original, id: "reply", content: "My live reply", ts: 2, quote: { text: original.content } };
    commitMessage(accountId, reply, false, { quoteTarget: { id: original.id } });
    expect(getChatMessage(accountId, key(reply.id))?.quote?.targetId).toBe(original.id);
    expect(commitMessage(accountId, original, true, echo)?.message.id).toBe(aliasedMessage.id);
    expect(getChatMessage(accountId, key(reply.id))?.quote?.targetId).toBe(aliasedMessage.id);
    storeMessage(aliasedMessage, "other-account");
    storeMessage({ ...aliasedMessage, id: original.id, threadType: "User" }, accountId);

    expect(markMessageRecalled(accountId, key(original.id))).toEqual({ messageId: aliasedMessage.id, changed: true });
    expect(markMessageRecalled(accountId, key(original.id))).toEqual({ messageId: aliasedMessage.id, changed: false });
    const tombstone = getChatMessage(accountId, key(aliasedMessage.id));
    expect(tombstone).toEqual({
      ...scope, id: aliasedMessage.id, ts: original.ts, fromId: accountId, fromName: "Alice",
      isSelf: true, content: recallText, recalled: true,
    });
    expect(getMessageProtocol(accountId, key(aliasedMessage.id))).toEqual({ message: tombstone });
    expect(getMessagesAround(scope.threadId, accountId, scope.threadType, original.id)).toEqual([
      tombstone, { ...reply, quote: { targetId: aliasedMessage.id, text: recallText } },
    ]);
    expect(getMessageAroundWindow(scope.threadId, accountId, scope.threadType, original.id)?.targetId).toBe(aliasedMessage.id);
    expect(getConversations(accountId, "Group")[0]?.lastMessage?.quote).toEqual({ targetId: aliasedMessage.id, text: recallText });
    expect(searchMessages(scope.threadId, accountId, scope.threadType, "confidential").results).toEqual([]);
    expect(searchMessages(scope.threadId, accountId, scope.threadType, recallText).results).toEqual([]);
    expect(hasChatMedia(accountId, mediaKey)).toBe(false);
    expect(attachChatMedia(accountId, { ...original, mediaType: "image" }, mediaKey)).toBeUndefined();
    expect(updateMessageReaction(scope.threadId, original.id, "heart", "reactor", "Bob", accountId, scope.threadType)).toBeUndefined();
    expect(commitMessage(accountId, original, false, echo)).toEqual({ message: tombstone, changed: false });
    expect(getChatMessage("other-account", key(aliasedMessage.id))?.content).toBe(original.content);
    expect(getChatMessage(accountId, { ...key(original.id), threadType: "User" })?.content).toBe(original.content);
  });

  it("does not treat a global undo or global reaction as an unproven CLI match", () => {
    const cliOnly = { ...original, id: identity.cliId };
    commitMessage(accountId, cliOnly, true, { source: "echo", identity: { senderId: accountId, cliId: cliOnly.id } });
    expect(updateMessageReaction(scope.threadId, cliOnly.id, "heart", "reactor", "Bob", accountId, scope.threadType, "global"))
      .toBeUndefined();
    expect(markMessageRecalled(accountId, key(cliOnly.id))?.changed).toBe(true);
    expect(getChatMessage(accountId, key(cliOnly.id))?.content).toBe(original.content);

    expect(markMessageRecalled(accountId, key(original.id))?.changed).toBe(true);
    expect(commitMessage(accountId, original, false, echo)?.message).toMatchObject({ id: cliOnly.id, recalled: true });
    expect(getChatMessage(accountId, key(cliOnly.id))).not.toHaveProperty("reactions");
  });

  it("merges a proven CLI row with a separate ACK without losing the ACK's quote snapshot or archived media", () => {
    const parent = { ...original, id: "parent", content: "Parent" };
    const first = { ...original, id: identity.cliId, mediaType: "image" } as const;
    storeMessage(parent, accountId, false);
    commitMessage(accountId, first, true, { source: "echo", identity: { senderId: accountId, cliId: first.id } });
    const ackPreview = { targetId: parent.id, text: parent.content, fromName: parent.fromName };
    commitMessage(accountId, { ...original, quote: ackPreview }, true, {
      ...ack, quoteTarget: { id: parent.id, senderId: parent.fromId },
    });
    attachChatMedia(accountId, { ...original, mediaType: "image" }, mediaKey);
    const merged = commitMessage(accountId, original, true, echo);
    expect(merged).toMatchObject({
      mergedId: original.id, changed: true,
      message: { id: first.id, quote: ackPreview, mediaUrl: `/api/chat/media/${mediaKey}` },
    });
    expect(getMessages(scope.threadId, accountId, scope.threadType)).toHaveLength(2);
    expect(getMessageProtocol(accountId, key(original.id))?.message.id).toBe(first.id);
  });

  it("rechecks archive authorization after undo and alias reconciliation while keeping another live reference", () => {
    const aliasedMessage = { ...original, id: identity.cliId, cliMsgId: identity.cliId, mediaType: "image" } as const;
    storeMessage(aliasedMessage, accountId, false);
    expect(markMessageRecalled(accountId, key(original.id))?.changed).toBe(true);
    expect(commitMessage(accountId, original, false, echo)?.message.recalled).toBe(true);
    expect(attachChatMedia(accountId, aliasedMessage, mediaKey)).toBeUndefined();
    expect(hasChatMedia(accountId, mediaKey)).toBe(false);
    const live = { ...aliasedMessage, id: "another-message", mediaUrl: `/api/chat/media/${mediaKey}` };
    storeMessage(live, accountId, false);
    expect(hasChatMedia(accountId, mediaKey)).toBe(true);
    expect(hasChatMedia("another-account", mediaKey)).toBe(false);
  });

  it("persists undo before the original and redacts quotes arriving after database reopen", () => {
    withLegacyDatabase(() => {
      const targetId = "not-yet-saved";
      expect(markMessageRecalled(accountId, key(targetId))).toEqual({ messageId: targetId, changed: true, hasLocalTarget: false });
      expect(getMessagesAround(scope.threadId, accountId, scope.threadType, targetId)).toBeUndefined();
      closeMessageStore();

      expect(commitMessage(accountId, { ...original, id: targetId }, true, {
        source: "echo", identity: { ...identity, globalId: targetId },
      })).toBeUndefined();
      const late = { ...original, id: "late-reply", quote: { text: original.content, fromName: "Alice" } };
      expect(commitMessage(accountId, late, false, { quoteTarget: { id: targetId } })?.message.quote)
        .toEqual({ targetId, text: recallText });
      expect(getChatMessage(accountId, key(targetId))).toBeUndefined();
      expect(getMessages(scope.threadId, accountId, scope.threadType)).toHaveLength(2);
    });
  });
});
