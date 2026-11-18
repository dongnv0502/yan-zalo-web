// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadType, type API, type Message } from "zca-js";
import { ingestZaloMessage, ingestZaloUndo } from "./chatIngest";
import { closeMessageStore, getMessages, hasChatMedia, markMessageRecalled } from "./messageStore";
import { archiveZaloMedia } from "./chatMedia";
import { publishAccountInvalidation } from "./socketServer";

vi.mock("./chatMedia", () => ({ archiveZaloMedia: vi.fn() }));
vi.mock("./socketServer", () => ({ publishAccountInvalidation: vi.fn(), publishSessionEvent: vi.fn() }));

const api = { getOwnId: () => "owner" } as API;
const activeSession = { api, accountId: "owner", generation: "test", isCurrent: () => true };
const input = (id: string, msgType: string, content: Record<string, unknown>) => ({
  type: ThreadType.Group, threadId: "room", isSelf: false,
  data: { msgId: id, uidFrom: "sender", msgType, ts: "1700000000000", content },
}) as Message;

beforeEach(() => {
  vi.stubEnv("CHAT_DB_PATH", ":memory:");
  vi.mocked(archiveZaloMedia).mockReset();
  vi.mocked(publishAccountInvalidation).mockClear();
});
afterEach(() => {
  closeMessageStore();
  vi.unstubAllEnvs();
});

it("archives Zalo photo and video bytes and leaves link previews as text", async () => {
  const photo = "https://s120.photo.zdn.vn/sample.jpg";
  const video = "https://video.zdn.vn/sample.mp4";
  await ingestZaloMessage(activeSession, input("1", "chat.photo", { href: photo, title: "An image caption" }), false);
  await ingestZaloMessage(activeSession, input("2", "chat.video.msg", { href: video, thumb: photo }), false);
  await ingestZaloMessage(activeSession, input("3", "webchat", { href: photo, msg: "Preview only" }), false);
  await ingestZaloMessage(activeSession, input("1", "chat.photo", { href: photo }), false);

  const messages = getMessages("room", "owner", "Group");
  expect(messages).toMatchObject([
    { id: "1", mediaType: "image", content: "An image caption", mediaUrl: expect.stringMatching(/^\/api\/chat\/media\/[a-f0-9]{64}$/) },
    { id: "2", mediaType: "video", mediaUrl: expect.stringMatching(/^\/api\/chat\/media\/[a-f0-9]{64}$/) },
    { id: "3", content: "Preview only" },
  ]);
  expect(messages[2].mediaUrl).toBeUndefined();
  expect(archiveZaloMedia).toHaveBeenCalledTimes(2);
  expect(archiveZaloMedia).toHaveBeenCalledWith(video, "video", expect.any(String));
});

it("keeps the message if the original media has expired and can archive it on replay", async () => {
  vi.mocked(archiveZaloMedia).mockRejectedValueOnce(new Error("gone"));
  const message = input("1", "share.file", { title: "sample.mp4", href: "https://file.zdn.vn/sample.mp4" });
  await ingestZaloMessage(activeSession, message, true);
  expect(getMessages("room", "owner", "Group")[0]).toMatchObject({ id: "1", mediaType: "video" });
  expect(getMessages("room", "owner", "Group")[0].mediaUrl).toBeUndefined();
  await ingestZaloMessage(activeSession, message, true);
  expect(getMessages("room", "owner", "Group")[0].mediaUrl).toMatch(/^\/api\/chat\/media\//);
});

it("does not attach media completed after the originating session is revoked", async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  vi.mocked(archiveZaloMedia).mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  const current = vi.fn(() => true);
  const session = { ...activeSession, isCurrent: current };
  const message = input("1", "chat.photo", { href: "https://s120.photo.zdn.vn/sample.jpg" });
  const ingest = ingestZaloMessage(session, message, true);
  await started.promise;
  current.mockReturnValue(false);
  pending.resolve();
  await ingest;
  expect(getMessages("room", "owner", "Group")[0].mediaUrl).toBeUndefined();
});

it("does not reattach bytes when a CLI-keyed upload is recalled during global ID reconciliation", async () => {
  const started = Promise.withResolvers<string>();
  const pending = Promise.withResolvers<void>();
  vi.mocked(archiveZaloMedia).mockImplementationOnce((_url, _type, key) => {
    started.resolve(key);
    return pending.promise;
  });
  const url = "https://s120.photo.zdn.vn/sample.jpg";
  const cliOnly = input("", "chat.photo", { href: url });
  cliOnly.data.cliMsgId = "201";
  const uploading = ingestZaloMessage(activeSession, cliOnly, true);
  const mediaKey = await started.promise;
  markMessageRecalled("owner", { threadId: "room", threadType: "Group", messageId: "101" });
  const globalEcho = input("101", "chat.photo", { href: url });
  globalEcho.data.cliMsgId = "201";
  await ingestZaloMessage(activeSession, globalEcho, true);
  pending.resolve();
  await uploading;
  expect(getMessages("room", "owner", "Group")).toMatchObject([{ id: "201", recalled: true, content: "Tin nhắn đã được thu hồi" }]);
  expect(hasChatMedia("owner", mediaKey)).toBe(false);
  expect(archiveZaloMedia).toHaveBeenCalledTimes(1);
});

it.each([false, true])("applies a live undo to the stored target, not the envelope (group: %s)", async (isGroup) => {
  const source = input("100", "webchat", { msg: "Không còn hiện" });
  const incoming = { ...source, type: isGroup ? ThreadType.Group : ThreadType.User,
    threadId: isGroup ? "room" : "sender" } as Message;
  await ingestZaloMessage(activeSession, incoming, false);
  const undo = { isGroup, isSelf: false, threadId: incoming.threadId, data: {
    uidFrom: "sender", idTo: isGroup ? "room" : "owner", msgId: "900", content: { globalMsgId: "100", deleteMsg: 1 },
  } };
  ingestZaloUndo(activeSession, undo);
  ingestZaloUndo(activeSession, undo);
  await ingestZaloMessage(activeSession, incoming, false);
  const threadType = isGroup ? "Group" : "User";
  expect(getMessages(incoming.threadId, "owner", threadType)).toMatchObject([{ id: "100", recalled: true, content: "Tin nhắn đã được thu hồi" }]);
  expect(publishAccountInvalidation).toHaveBeenCalledExactlyOnceWith(activeSession, { threadId: incoming.threadId, threadType, messageId: "100" });
});
