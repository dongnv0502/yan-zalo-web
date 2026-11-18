// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadType, type API, type Message } from "zca-js";
import { ingestZaloMessage } from "./chatIngest";
import { closeMessageStore, getMessages } from "./messageStore";
import { archiveZaloMedia } from "./chatMedia";

vi.mock("./chatMedia", () => ({ archiveZaloMedia: vi.fn() }));

const api = { getOwnId: () => "owner" } as API;
const input = (id: string, msgType: string, content: Record<string, unknown>) => ({
  type: ThreadType.Group, threadId: "room", isSelf: false,
  data: { msgId: id, uidFrom: "sender", msgType, ts: "1700000000000", content },
}) as Message;

beforeEach(() => {
  vi.stubEnv("CHAT_DB_PATH", ":memory:");
  vi.mocked(archiveZaloMedia).mockReset();
});
afterEach(() => {
  closeMessageStore();
  vi.unstubAllEnvs();
});

it("archives Zalo photo and video bytes and leaves link previews as text", async () => {
  const photo = "https://s120.photo.zdn.vn/sample.jpg";
  const video = "https://video.zdn.vn/sample.mp4";
  await ingestZaloMessage(api, "sid", input("1", "chat.photo", { href: photo, title: "An image caption" }), false);
  await ingestZaloMessage(api, "sid", input("2", "chat.video.msg", { href: video, thumb: photo }), false);
  await ingestZaloMessage(api, "sid", input("3", "webchat", { href: photo, msg: "Preview only" }), false);
  await ingestZaloMessage(api, "sid", input("1", "chat.photo", { href: photo }), false);

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
  await ingestZaloMessage(api, "sid", message, true);
  expect(getMessages("room", "owner", "Group")[0]).toMatchObject({ id: "1", mediaType: "video" });
  expect(getMessages("room", "owner", "Group")[0].mediaUrl).toBeUndefined();
  await ingestZaloMessage(api, "sid", message, true);
  expect(getMessages("room", "owner", "Group")[0].mediaUrl).toMatch(/^\/api\/chat\/media\//);
});
