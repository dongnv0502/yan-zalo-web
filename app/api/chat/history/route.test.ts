// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import { closeMessageStore } from "@/lib/messageStore";
import { GET } from "./route";

const { getGroupChatHistory } = vi.hoisted(() => ({ getGroupChatHistory: vi.fn() }));
vi.mock("@/lib/zalo", () => ({ getZaloSession: () => ({
  accountId: "account", generation: "fixture", isCurrent: () => true, api: { getGroupChatHistory },
}) }));
beforeEach(() => vi.stubEnv("CHAT_DB_PATH", ":memory:"));
afterEach(() => { closeMessageStore(); vi.unstubAllEnvs(); });

it.each([true, false])("does not present or apply an unverified undo marker (marker first: %s)", async (first) => {
  const original = { type: ThreadType.Group, threadId: "room", isSelf: false, data: {
    msgId: "100", cliMsgId: "200", uidFrom: "sender", idTo: "room", msgType: "webchat", ts: "1700000000000", content: "Tin đã lưu",
  } };
  const marker = { ...original, data: { ...original.data, msgId: "900", cliMsgId: "901", content: { deleteMsg: 1, globalMsgId: "100" } } };
  getGroupChatHistory.mockResolvedValue({ groupMsgs: first ? [marker, original] : [original, marker] });
  const response = await GET(new NextRequest("http://localhost/api/chat/history?groupId=room"));
  expect(response.status).toBe(200);
  expect((await response.json()).messages.map(({ id, content, recalled }: { id: string; content: string; recalled?: boolean }) => ({ id, content, recalled })))
    .toEqual([{ id: "100", content: "Tin đã lưu", recalled: undefined }]);
});
