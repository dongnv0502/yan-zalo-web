// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types/chat";

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
