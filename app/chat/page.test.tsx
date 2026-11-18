import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Conversation } from "@/types/chat";
import ChatPage from "./page";

const { socketHandlers, router } = vi.hoisted(() => ({
  socketHandlers: new Map<string, (payload: ChatMessage, options?: { mediaUpdate: boolean } | null) => void>(),
  router: { replace: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, listener: (payload: ChatMessage, options?: { mediaUpdate: boolean } | null) => void) => socketHandlers.set(event, listener),
    off: (event: string) => socketHandlers.delete(event),
    disconnect: vi.fn(),
    connect: () => socketHandlers.get("connect")?.({} as ChatMessage),
    timeout: () => ({ emit: (_event: string, reply: (error: null, data: { ok: boolean }) => void) => reply(null, { ok: true }) }),
  }),
}));

const direct: Conversation = { id: "shared-id", type: "User", name: "An", unread: 0 };
const group: Conversation = { id: direct.id, type: "Group", name: "Nhóm thử", unread: 0 };
const imageUrl = `/api/chat/media/${"a".repeat(64)}`;
const videoUrl = `/api/chat/media/${"b".repeat(64)}`;

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "shared-message", threadId: direct.id, threadType: direct.type,
    fromId: "other-user", fromName: direct.name, content: "", ts: 1, isSelf: false,
    ...overrides,
  };
}

function mockChatApi(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const request = vi.fn(async (url: string, _init?: RequestInit) => {
    if (overrides[url]) return overrides[url]();
    if (url === "/api/auth/status") return Response.json({ status: "logged_in" });
    if (url === "/api/chat/conversations") return Response.json({ conversations: [direct, group] });
    if (url === "/api/chat/conversations?type=User") return Response.json({ conversations: [direct] });
    if (url === "/api/chat/conversations?type=Group") return Response.json({ conversations: [group] });
    if (url === "/api/chat/quick-messages") return Response.json({ items: [] });
    if (url === "/api/chat/mark-read") return Response.json({ ok: true });
    return Response.json({ error: "Unexpected fixture request" }, { status: 404 });
  });
  vi.stubGlobal("fetch", request);
  return request;
}

async function emitMessage(payload: ChatMessage, options?: { mediaUpdate: boolean } | null) {
  await act(async () => socketHandlers.get("message")?.(payload, options));
}

describe("chat message media", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("localStorage", { getItem: vi.fn(), removeItem: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    socketHandlers.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns to the conversation list from the Chat tab without leaving the page", async () => {
    mockChatApi({
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => Response.json({ messages: [] }),
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByRole("textbox", { name: "Nội dung tin nhắn" });

    const navigation = screen.getByRole("navigation", { name: "Điều hướng di động" });
    const chat = within(navigation).getByRole("link", { name: "Chat", current: "page" });
    expect(within(navigation).getByRole("link", { name: "Tiện ích" }).getAttribute("href")).toBe("/tien-ich");
    fireEvent.click(chat);

    expect(screen.queryByRole("textbox", { name: "Nội dung tin nhắn" })).toBeNull();
    expect(screen.getByRole("button", { name: "An" })).toBeTruthy();
  });

  it("sends a reaction through message actions without hover", async () => {
    const original = message({ content: "Tin để thả cảm xúc" });
    const request = mockChatApi({
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => Response.json({ messages: [original] }),
      "/api/chat/reaction": () => Response.json({ ok: true }),
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    fireEvent.click(await screen.findByRole("button", { name: "Thao tác tin nhắn" }));
    fireEvent.click(screen.getByRole("button", { name: "Thả cảm xúc 👍" }));

    const reaction = request.mock.calls.find(([url]) => url === "/api/chat/reaction");
    expect(reaction?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(reaction?.[1]?.body))).toMatchObject({ messageId: original.id, icon: ":>" });
  });

  it("jumps with Enter and discards a late previous-result jump after returning to latest", async () => {
    const first = message({ id: "old-a", content: "Điện báo", ts: 1 });
    const second = message({ id: "old-b", content: "Điện thoại", ts: 2 });
    const latest = message({ id: "latest", content: "Tin mới", ts: 300 });
    const base = `/api/chat/messages?threadId=${direct.id}&threadType=User`;
    const { promise: pending, resolve: resolveOld } = Promise.withResolvers<Response>();
    const request = mockChatApi({
      [base]: () => Response.json({ messages: [latest] }),
      [`${base}&around=${second.id}`]: () => Response.json({ messages: [second] }),
      [`${base}&around=${first.id}`]: () => pending,
      "/api/chat/search": () => Response.json({ results: [second, first].map((item) => ({
        id: item.id, fromName: item.fromName, ts: item.ts, excerpt: item.content,
      })), hasMore: false }),
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await within(screen.getByRole("main")).findByText("Tin mới");
    fireEvent.click(screen.getByRole("button", { name: "Tìm tin nhắn" }));
    const input = screen.getByRole("searchbox", { name: "Lịch sử đã lưu" });
    fireEvent.change(input, { target: { value: "điện" } });
    await screen.findByText("1/2");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("Điện", { selector: "mark" })).toHaveLength(2));
    expect(screen.queryByText("Tin mới")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(request.mock.calls.some(([url]) => url.endsWith("around=old-a"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Về tin mới nhất" }));
    await act(async () => resolveOld(Response.json({ messages: [first] })));
    expect(within(screen.getByRole("main")).getByText("Tin mới")).toBeTruthy();
  });

  it("preserves the draft and quote on a failed send", async () => {
    const original = { ...message({ content: "Tin gốc" }), canReply: true };
    const base = `/api/chat/messages?threadId=${direct.id}&threadType=User`;
    const request = mockChatApi({
      [base]: () => Response.json({ messages: [original] }),
      "/api/chat/send": () => Response.json({ error: "Không gửi được" }, { status: 502 }),
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByText("Tin gốc");
    const input = screen.getByRole("textbox", { name: "Nội dung tin nhắn" });
    fireEvent.change(input, { target: { value: "Nháp chưa gửi" } });
    fireEvent.click(screen.getByRole("button", { name: "Thao tác tin nhắn" }));
    fireEvent.click(screen.getByRole("button", { name: "Trả lời" }));
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("alert");
    const send = request.mock.calls.find(([url]) => url === "/api/chat/send");
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({ replyToId: original.id, text: "Nháp chưa gửi" });
    expect((input as HTMLTextAreaElement).value).toBe("Nháp chưa gửi");
    expect(screen.getByRole("button", { name: "Bỏ trích dẫn" })).toBeTruthy();
  });

  it("never restores content or a reply excerpt when recall arrives before a stale snapshot", async () => {
    const source = message({ id: "source", content: "Riêng tư" });
    const reply = { ...message({ id: "reply", content: "Đã đọc", ts: 2 }), quote: { targetId: source.id, text: source.content } };
    const delayed = Promise.withResolvers<Response>();
    const base = `/api/chat/messages?threadId=${direct.id}&threadType=User`;
    const request = mockChatApi({ [base]: () => delayed.promise });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await waitFor(() => expect(request.mock.calls.some(([url]) => url === base)).toBe(true));
    await act(async () => socketHandlers.get("message_recalled")?.({
      threadId: direct.id, threadType: direct.type, messageId: source.id,
    } as unknown as ChatMessage));
    await act(async () => delayed.resolve(Response.json({ messages: [source, reply] })));
    expect(await screen.findByText("Đã đọc")).toBeTruthy();
    expect(screen.queryAllByText("Riêng tư")).toHaveLength(0);
    expect(screen.getAllByText("Tin nhắn đã được thu hồi")).toHaveLength(2);
  });

  it("conceals disconnected content when the resync snapshot fails", async () => {
    const previous = message({ content: "Chỉ thấy trước khi rớt mạng" });
    const reconnect = Promise.withResolvers<Response>();
    let calls = 0;
    mockChatApi({
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => ++calls === 1
        ? Response.json({ messages: [previous] }) : reconnect.promise,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByText(previous.content);
    await act(async () => socketHandlers.get("disconnect")?.(previous));
    expect(screen.queryByText(previous.content)).toBeNull();
    await act(async () => socketHandlers.get("connect")?.(previous));
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => reconnect.resolve(Response.json({}, { status: 500 })));
    expect(await screen.findByText("Không thể đồng bộ lịch sử đã lưu.")).toBeTruthy();
    expect(screen.queryByText(previous.content)).toBeNull();
  });

  it("discards a delayed search response after switching between scopes with the same thread ID", async () => {
    const pending = Promise.withResolvers<Response>();
    const request = mockChatApi({
      "/api/chat/search": () => pending.promise,
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => Response.json({ messages: [message({ content: "Tin bạn bè" })] }),
      [`/api/chat/messages?threadId=${group.id}&threadType=Group`]: () => Response.json({ messages: [message({ threadType: "Group", content: "Tin nhóm" })] }),
      [`/api/chat/history?groupId=${group.id}&count=50`]: () => Response.json({ messages: [] }),
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByText("Tin bạn bè");
    fireEvent.click(screen.getByRole("button", { name: "Tìm tin nhắn" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "riêng" } });
    await waitFor(() => expect(request.mock.calls.some(([url]) => url === "/api/chat/search")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm" }));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm thử" }));
    await screen.findByText("Tin nhóm");
    fireEvent.click(screen.getByRole("button", { name: "Tìm tin nhắn" }));
    await act(async () => pending.resolve(Response.json({ results: [{ id: "other", excerpt: "Riêng cho bạn bè", ts: 1 }], hasMore: false })));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Riêng cho bạn bè")).toBeNull();
  });

  it.each([false, true])("keeps SQLite BINARY preview ordering at a tied timestamp (live first: %s)", async (liveFirst) => {
    const snapshot = Promise.withResolvers<Response>();
    const older = message({ id: "Z", content: "Tin Z", ts: 10 });
    const newer = message({ id: "a", content: "Tin a", ts: 10 });
    const request = mockChatApi({
      "/api/chat/conversations?type=User": () => snapshot.promise,
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => Response.json({ messages: [newer, older] }),
    });
    render(<ChatPage />);
    await screen.findByRole("button", { name: "An" });
    await waitFor(() => expect(request.mock.calls.some(([url]) => url.endsWith("type=User"))).toBe(true));
    if (liveFirst) await emitMessage(newer);
    await act(async () => snapshot.resolve(Response.json({ conversations: [{ ...direct, lastMessage: older }] })));
    if (!liveFirst) await emitMessage(newer);
    const conversation = await screen.findByRole("button", { name: /An.*Tin a/ });
    fireEvent.click(conversation);
    const main = within(screen.getByRole("main"));
    const first = await main.findByText("Tin Z");
    expect(first.compareDocumentPosition(main.getByText("Tin a")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([true, false])("does not replace a newer draft after switching A → B → A (ACK succeeds: %s)", async (success) => {
    const receipt = Promise.withResolvers<Response>();
    const original = { ...message({ content: "Nội dung gốc" }), canReply: true };
    const own = message({ id: "sent", content: "Nháp đã gửi", isSelf: true, ts: 2 });
    const request = mockChatApi({
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => Response.json({ messages: [original] }),
      [`/api/chat/messages?threadId=${group.id}&threadType=Group`]: () => Response.json({ messages: [] }),
      [`/api/chat/history?groupId=${group.id}&count=50`]: () => Response.json({ messages: [] }),
      "/api/chat/send": () => receipt.promise,
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByText(original.content);
    const composer = () => screen.getByRole("textbox", { name: "Nội dung tin nhắn" }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "Thao tác tin nhắn" }));
    fireEvent.click(screen.getByRole("button", { name: "Trả lời" }));
    fireEvent.change(composer(), { target: { value: own.content } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(request.mock.calls.some(([url]) => url === "/api/chat/send")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm" }));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm thử" }));
    fireEvent.change(composer(), { target: { value: "Nháp ở nhóm" } });
    fireEvent.click(screen.getByRole("button", { name: "Bạn bè" }));
    fireEvent.click(screen.getByRole("button", { name: "An" }));
    fireEvent.change(composer(), { target: { value: "Nháp mới" } });
    await act(async () => receipt.resolve(success ? Response.json({ message: own }) : Response.json({ error: "Từ chối" }, { status: 502 })));
    expect(composer().value).toBe("Nháp mới");
    expect(screen.getByRole("button", { name: "Bỏ trích dẫn" })).toBeTruthy();
    expect(screen.queryByText("Từ chối")).toBeNull();
    if (success) {
      await emitMessage(own);
      expect(within(screen.getByRole("main")).getAllByText(own.content)).toHaveLength(1);
    }
  });

  it("retains an owned message and reports an explicit refusal to recall it", async () => {
    const own = { ...message({ content: "Không thể thu hồi", isSelf: true }), canRecall: true };
    const request = mockChatApi({
      [`/api/chat/messages?threadId=${direct.id}&threadType=User`]: () => Response.json({ messages: [own] }),
      "/api/chat/recall": () => Response.json({ error: "Zalo từ chối" }, { status: 422 }),
    });
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByText(own.content);
    fireEvent.click(screen.getByRole("button", { name: "Thao tác tin nhắn" }));
    fireEvent.click(screen.getByRole("button", { name: "Thu hồi" }));
    expect(await screen.findByText("Zalo từ chối")).toBeTruthy();
    expect(within(screen.getByRole("main")).getByText(own.content)).toBeTruthy();
    expect(screen.queryByText("Tin nhắn đã được thu hồi")).toBeNull();
    expect(request.mock.calls.filter(([url]) => url === "/api/chat/recall")).toHaveLength(1);
  });

  it("renders archived photos and playable videos with captions, and handles unavailable media", async () => {
    const photo = message({ mediaType: "image", mediaUrl: imageUrl, content: "Ảnh từ chuyến đi" });
    const video = message({ id: "video", mediaType: "video", mediaUrl: videoUrl, content: "Video từ chuyến đi", ts: 2 });
    const unsafeVideo = message({ id: "external-video", mediaType: "video", mediaUrl: "//external.test/video.mp4", ts: 3 });
    const missingImage = message({ id: "missing-image", mediaType: "image", ts: 4 });
    mockChatApi({
      "/api/chat/messages?threadId=shared-id&threadType=User": () => Response.json({ messages: [photo, video, unsafeVideo, missingImage] }),
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));

    const image = await screen.findByRole("img", { name: "Hình ảnh" });
    const player = screen.getByLabelText("Video");
    expect(new URL((image as HTMLImageElement).src).pathname).toBe(imageUrl);
    expect(new URL((image as HTMLImageElement).src).origin).toBe(location.origin);
    expect(image.hasAttribute("srcset")).toBe(false);
    expect(player.tagName).toBe("VIDEO");
    expect(player.getAttribute("src")).toBe(videoUrl);
    expect(player.hasAttribute("controls")).toBe(true);
    expect(player.hasAttribute("playsinline")).toBe(true);
    expect(player.getAttribute("preload")).toBe("metadata");
    expect(screen.getByText("Ảnh từ chuyến đi")).toBeDefined();
    expect(screen.getByText("Video từ chuyến đi")).toBeDefined();
    expect(screen.getByText("Hình ảnh không khả dụng")).toBeDefined();
    expect(screen.getByText("Video không khả dụng")).toBeDefined();

    fireEvent.error(image);
    fireEvent.error(player);
    expect(screen.queryByRole("img", { name: "Hình ảnh" })).toBeNull();
    expect(screen.queryByLabelText("Video")).toBeNull();
    expect(screen.getAllByText("Hình ảnh không khả dụng")).toHaveLength(2);
    expect(screen.getAllByText("Video không khả dụng")).toHaveLength(2);
    expect(screen.getByText("Ảnh từ chuyến đi")).toBeDefined();
  });

  it("shows incoming text in the open conversation without reloading the transcript", async () => {
    const transcriptUrl = `/api/chat/messages?threadId=${direct.id}&threadType=User`;
    const request = mockChatApi({ [transcriptUrl]: () => Response.json({ messages: [] }) });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    await screen.findByRole("textbox", { name: "Nội dung tin nhắn" });

    // Socket.io encodes an explicit undefined argument as null on the wire.
    await emitMessage(message({ content: "Tin chữ vừa đến" }), null);

    expect(within(screen.getByRole("main")).getByText("Tin chữ vừa đến")).toBeTruthy();
    expect(request.mock.calls.filter(([url]) => url === transcriptUrl)).toHaveLength(1);
  });

  it("merges group history with live and archived messages without letting a stale thread overwrite it", async () => {
    const directLoad = Promise.withResolvers<Response>();
    const archiveLoad = Promise.withResolvers<Response>();
    const historyLoad = Promise.withResolvers<Response>();
    const request = mockChatApi({
      "/api/chat/messages?threadId=shared-id&threadType=User": () => directLoad.promise,
      "/api/chat/messages?threadId=shared-id&threadType=Group": () => archiveLoad.promise,
      "/api/chat/history?groupId=shared-id&count=50": () => historyLoad.promise,
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole("button", { name: "An" }));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm" }));
    fireEvent.click(screen.getByRole("button", { name: "Nhóm thử" }));
    const live = message({ threadType: "Group", content: "Tin nhắn trực tiếp", mediaType: "image", ts: 10 });
    await emitMessage(live);
    await emitMessage(message({ id: "wrong-thread-type", content: "Không thuộc nhóm" }));
    await act(async () => historyLoad.resolve(Response.json({ messages: [
      message({ id: "old", threadType: "Group", content: "Lịch sử nhóm" }), live,
    ] })));
    await act(async () => archiveLoad.resolve(Response.json({ messages: [{ ...live, mediaUrl: imageUrl }] })));
    await act(async () => directLoad.resolve(Response.json({ messages: [message({ content: "Bạn bè đến muộn" })] })));

    const main = within(screen.getByRole("main"));
    expect(new URL((main.getByRole("img", { name: "Hình ảnh" }) as HTMLImageElement).src).pathname).toBe(imageUrl);
    expect(main.getAllByText("Tin nhắn trực tiếp")).toHaveLength(1);
    expect(main.getByText("Lịch sử nhóm").compareDocumentPosition(main.getByText("Tin nhắn trực tiếp")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.queryByText("Không thuộc nhóm")).toBeNull();
    expect(main.queryByText("Bạn bè đến muộn")).toBeNull();
    expect(request.mock.calls).toContainEqual(["/api/chat/mark-read", expect.objectContaining({ body: JSON.stringify({ threadId: group.id, threadType: group.type }) })]);
  });

  it("upgrades a repeated socket message without counting it unread or replacing a newer preview", async () => {
    const live = message({ mediaType: "image", content: "Hình mới", ts: 2 });
    const latest = message({ id: "latest", content: "Sau hình mới", ts: 3 });
    mockChatApi({
      "/api/chat/messages?threadId=shared-id&threadType=User": () => Response.json({ messages: [] }),
    });
    render(<ChatPage />);
    await screen.findByRole("button", { name: "An" });
    await emitMessage(live);
    await emitMessage(latest);
    await emitMessage({ ...live, mediaUrl: imageUrl });
    await emitMessage(message({ id: "unseen-history", mediaType: "image", mediaUrl: imageUrl, ts: 1 }), { mediaUpdate: true });
    const conversation = screen.getByRole("button", { name: /An.*Sau hình mới/ });
    expect(within(conversation).getByText("2")).toBeDefined();
    expect(within(conversation).queryByText("3")).toBeNull();

    fireEvent.click(conversation);
    await emitMessage(live);
    await emitMessage({ ...live, mediaUrl: imageUrl }, { mediaUpdate: true });
    const main = within(screen.getByRole("main"));
    expect(new URL((main.getByRole("img", { name: "Hình ảnh" }) as HTMLImageElement).src).pathname).toBe(imageUrl);
    expect(main.getAllByText("Hình mới")).toHaveLength(1);
  });

  it("does not fetch conversations until the stored session has been restored", async () => {
    vi.mocked(localStorage.getItem).mockReturnValue('{"imei":"stored"}');
    const restoring = Promise.withResolvers<Response>();
    const request = mockChatApi({
      "/api/auth/status": () => Response.json({ status: "logged_out" }),
      "/api/auth/restore": () => restoring.promise,
    });
    render(<ChatPage />);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/auth/restore", expect.anything()));
    expect(request.mock.calls.some(([url]) => url.startsWith("/api/chat/conversations") || url === "/api/chat/quick-messages")).toBe(false);
    await act(async () => restoring.resolve(Response.json({ status: "logged_in" })));
    expect(await screen.findByRole("button", { name: "An" })).toBeDefined();
  });

  it.each(["User", "Group"] as const)("shows the saved list and the refreshed %s list without waiting for the other", async (firstType) => {
    const friends = Promise.withResolvers<Response>();
    const groups = Promise.withResolvers<Response>();
    mockChatApi({
      "/api/chat/conversations": () => Response.json({ conversations: [{ ...direct, name: "Bạn đã lưu" }] }),
      "/api/chat/conversations?type=User": () => friends.promise,
      "/api/chat/conversations?type=Group": () => groups.promise,
    });
    render(<ChatPage />);
    expect(await screen.findByRole("button", { name: "Bạn đã lưu" })).toBeDefined();

    if (firstType === "Group") {
      fireEvent.click(screen.getByRole("button", { name: "Nhóm" }));
      expect(screen.getByRole("status").textContent).toBe("Đang tải nhóm…");
      await act(async () => groups.resolve(Response.json({ conversations: [group] })));
      expect(screen.getByRole("button", { name: group.name })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Bạn bè" }));
      expect(screen.getByRole("button", { name: "Bạn đã lưu" })).toBeDefined();
      await act(async () => friends.resolve(Response.json({ conversations: [direct] })));
    } else {
      await act(async () => friends.resolve(Response.json({ conversations: [direct] })));
      expect(screen.getByRole("button", { name: direct.name })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Nhóm" }));
      expect(screen.getByRole("status").textContent).toBe("Đang tải nhóm…");
      await act(async () => groups.resolve(Response.json({ conversations: [group] })));
      expect(screen.getByRole("button", { name: group.name })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Bạn bè" }));
    }
    expect(screen.getByRole("button", { name: direct.name })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Bạn đã lưu" })).toBeNull();
  });
});
