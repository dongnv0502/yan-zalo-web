import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Conversation } from "@/types/chat";
import ChatPage from "./page";

const { socketHandlers, router } = vi.hoisted(() => ({
  socketHandlers: new Map<string, (payload: ChatMessage, options?: { mediaUpdate: boolean }) => void>(),
  router: { replace: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, listener: (payload: ChatMessage, options?: { mediaUpdate: boolean }) => void) => socketHandlers.set(event, listener),
    off: (event: string) => socketHandlers.delete(event),
    disconnect: vi.fn(),
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

async function emitMessage(payload: ChatMessage, options?: { mediaUpdate: boolean }) {
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
