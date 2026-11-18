"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { Smile, MessageSquare, BookMarked, Plus, Paperclip, Forward, BarChart2, ArrowLeft, ImageOff, VideoOff } from "lucide-react";
import type { ChatMessage, Conversation, StickerDetail, Tab, PickerTab, ThreadType } from "@/types/chat";
import { useQuickMessages } from "@/lib/useQuickMessages";
import { REACTION_ICONS, REACTION_SHORTCODES } from "@/lib/reactionIcons";

// Common emoji groups for the emoji tab
const EMOJI_GROUPS = [
  "😀","😂","🥹","😍","🥰","😎","🤔","😅","😭","😤","🤯","🥳","😴","🤮","😷",
  "🎉","❤️","🔥","✨","💯","👍","👎","🙏","💪","🤝","👏","🫶","💔","😈","👻",
  "🎵","🍕","🎮","🏆","🚀","🌸","🌈","⚡","💎","🎯",
];

const ARCHIVED_MEDIA_PATH = /^\/api\/chat\/media\/[a-f0-9]{64}$/;

function ArchivedMedia({ mediaType, mediaUrl, content }: Pick<ChatMessage, "mediaType" | "mediaUrl" | "content">) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const isVideo = mediaType === "video";
  const label = isVideo ? "Video" : "Hình ảnh";
  const UnavailableIcon = isVideo ? VideoOff : ImageOff;
  const caption = /^\[(ảnh|video)\]$/i.test(content.trim()) ? "" : content;
  const src = mediaUrl && mediaUrl !== failedUrl && ARCHIVED_MEDIA_PATH.test(mediaUrl) ? mediaUrl : undefined;

  return (
    <figure className="w-80 max-w-full">
      {src ? (
        isVideo ? (
          <video
            src={src}
            aria-label={label}
            className="block w-full max-h-80 rounded-lg bg-black"
            controls
            playsInline
            preload="metadata"
            onError={() => setFailedUrl(src)}
          />
        ) : (
          <Image
            src={src}
            alt={label}
            width={320}
            height={240}
            unoptimized
            className="block w-full h-auto max-h-80 rounded-lg bg-black/5 object-contain"
            onError={() => setFailedUrl(src)}
          />
        )
      ) : (
        <p className="flex min-h-20 items-center justify-center gap-2 rounded-lg bg-black/5 p-3 text-sm">
          <UnavailableIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
          {label} không khả dụng
        </p>
      )}
      {caption && <figcaption className="mt-2 whitespace-pre-wrap break-words">{caption}</figcaption>}
    </figure>
  );
}

function conversationKey(threadId: string, threadType: ThreadType): string {
  return `${threadType}:${threadId}`;
}

function isConversation(conversation: Conversation | null, threadId: string, threadType: ThreadType): boolean {
  return conversation?.id === threadId && conversation.type === threadType;
}

function addReaction(message: ChatMessage, icon: string, senderId: string, senderName: string): ChatMessage {
  const reactions = message.reactions ?? [];
  const existing = reactions.find((reaction) => reaction.icon === icon);
  if (existing?.senderIds.includes(senderId)) return message;

  return {
    ...message,
    reactions: existing
      ? reactions.map((reaction) => reaction === existing ? {
          ...reaction,
          senderIds: [...reaction.senderIds, senderId],
          senderNames: [...reaction.senderNames, senderName],
        } : reaction)
      : [...reactions, { icon, senderIds: [senderId], senderNames: [senderName] }],
  };
}

function mergeMessage(fallback: ChatMessage, preferred: ChatMessage): ChatMessage {
  let merged: ChatMessage = {
    ...preferred,
    mediaType: preferred.mediaType ?? fallback.mediaType,
    mediaUrl: preferred.mediaUrl ?? fallback.mediaUrl,
    cliMsgId: preferred.cliMsgId ?? fallback.cliMsgId,
    reactions: preferred.reactions ?? fallback.reactions,
  };
  if (preferred.reactions) {
    for (const reaction of fallback.reactions ?? []) {
      reaction.senderIds.forEach((senderId, index) => {
        merged = addReaction(merged, reaction.icon, senderId, reaction.senderNames[index]);
      });
    }
  }
  return merged;
}

function mergeThreadMessages(current: ChatMessage[], incoming: ChatMessage[], history = false): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing
      ? history ? mergeMessage(message, existing) : mergeMessage(existing, message)
      : message);
  }
  return Array.from(byId.values()).sort((left, right) => left.ts - right.ts);
}

export default function ChatPage() {
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const checkAuth = async () => {
      try {
        const response = await fetch("/api/auth/status", { signal });
        const data = await response.json();
        if (signal.aborted) return;
        if (response.ok && data.status === "logged_in") {
          setAuthenticated(true);
          return;
        }

        const storedSession = localStorage.getItem("zalo_session");
        if (storedSession) {
          const restored = await fetch("/api/auth/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: storedSession,
            signal,
          });
          const restoredData = await restored.json();
          if (signal.aborted) return;
          if (restored.ok && restoredData.status === "logged_in") {
            setAuthenticated(true);
            return;
          }
          localStorage.removeItem("zalo_session");
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error("Không thể kiểm tra phiên Zalo:", error);
      }
      router.replace("/login");
    };

    void checkAuth();
    return () => controller.abort();
  }, [router]);

  return authenticated ? <AuthenticatedChat /> : (
    <div role="status" className="grid min-h-dvh place-items-center bg-gray-50 text-sm text-gray-600">
      Đang kiểm tra phiên đăng nhập…
    </div>
  );
}

function AuthenticatedChat() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listStatus, setListStatus] = useState<Record<ThreadType, "loading" | "ready" | "error">>({
    User: "loading",
    Group: "loading",
  });
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<Tab>("direct");
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<PickerTab>("sticker");
  const [stickerQuery, setStickerQuery] = useState("");
  const [stickers, setStickers] = useState<StickerDetail[]>([]);
  const [stickerLoading, setStickerLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const templatePanelRef = useRef<HTMLDivElement>(null);
  // Updated on selection so a socket or request cannot observe the previous thread between renders.
  const activeRef = useRef<Conversation | null>(null);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [addTemplateError, setAddTemplateError] = useState<string | null>(null);
  const { templates, loading: templatesLoading, addTemplate } = useQuickMessages();

  // Reaction hover state
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);

  // Forward message state
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const [forwardSearch, setForwardSearch] = useState("");
  const [forwardSuccess, setForwardSuccess] = useState(false);

  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Poll state
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollMultiChoice, setPollMultiChoice] = useState(false);
  const [pollAnonymous, setPollAnonymous] = useState(false);
  const [pollCreating, setPollCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const sock = io({ path: "/api/socketio", transports: ["websocket", "polling"] });
    const seenMessageKeys = new Set<string>();
    const refreshedTypes = new Set<ThreadType>();

    const loadConversations = async (type?: ThreadType) => {
      try {
        const url = type ? `/api/chat/conversations?type=${type}` : "/api/chat/conversations";
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (signal.aborted) return;
        if (!Array.isArray(data.conversations)) throw new Error("Invalid conversations response");
        const snapshot: Conversation[] = type
          ? data.conversations
          : (data.conversations as Conversation[]).filter((conversation) => !refreshedTypes.has(conversation.type));
        if (type) {
          refreshedTypes.add(type);
          setListStatus((current) => ({ ...current, [type]: "ready" }));
        }
        const selected = activeRef.current;

        // Keep messages that arrived while the initial conversation list was loading.
        setConversations((current) => {
          const byThread = new Map(current.map((conversation) => [conversationKey(conversation.id, conversation.type), conversation]));
          for (const conversation of snapshot) {
            const key = conversationKey(conversation.id, conversation.type);
            const live = byThread.get(key);
            const archivedMessage = conversation.lastMessage;
            const liveMessage = live?.lastMessage;
            const lastMessage = archivedMessage && liveMessage?.id === archivedMessage.id
              ? mergeMessage(liveMessage, archivedMessage)
              : liveMessage && liveMessage.ts >= (archivedMessage?.ts ?? 0) ? liveMessage : archivedMessage;
            byThread.set(key, {
              ...conversation,
              lastMessage,
              unread: isConversation(selected, conversation.id, conversation.type) ? 0 : Math.max(conversation.unread, live?.unread ?? 0),
            });
          }
          return Array.from(byThread.values()).sort((left, right) => (right.lastMessage?.ts ?? 0) - (left.lastMessage?.ts ?? 0));
        });
      } catch (error) {
        if (signal.aborted) return;
        if (type) setListStatus((current) => ({ ...current, [type]: "error" }));
        console.error("Không thể tải cuộc trò chuyện:", error);
      }
    };

    const onMessage = (message: ChatMessage, { mediaUpdate = false } = {}) => {
      const threadIsActive = isConversation(activeRef.current, message.threadId, message.threadType);
      const messageKey = JSON.stringify([message.threadType, message.threadId, message.id]);
      const seen = seenMessageKeys.has(messageKey);
      if (!seen && !mediaUpdate) {
        seenMessageKeys.add(messageKey);
        // Bound replay bookkeeping to recent events during this chat session.
        if (seenMessageKeys.size > 2000) {
          const oldest = seenMessageKeys.values().next();
          if (!oldest.done) seenMessageKeys.delete(oldest.value);
        }
      }

      setConversations((current) => {
        const index = current.findIndex((conversation) => isConversation(conversation, message.threadId, message.threadType));
        if (index === -1) {
          if (mediaUpdate) return current;
          return [{
            id: message.threadId,
            type: message.threadType,
            name: message.fromName || message.threadId,
            lastMessage: message,
            unread: threadIsActive || message.isSelf ? 0 : 1,
          }, ...current];
        }

        const conversation = current[index];
        const previous = conversation.lastMessage;
        const sameMessage = previous?.id === message.id;
        const newest = !mediaUpdate && !seen && !sameMessage && (!previous || message.ts >= previous.ts);
        const unread = threadIsActive ? 0 : conversation.unread + Number(!mediaUpdate && !message.isSelf && !seen && !sameMessage);
        if (sameMessage || newest || unread !== conversation.unread) {
          const updated = {
            ...conversation,
            unread,
            lastMessage: sameMessage ? mergeMessage(previous, message) : newest ? message : previous,
          };
          if (newest) return [updated, ...current.filter((_, position) => position !== index)];
          return current.map((item, position) => position === index ? updated : item);
        }
        return current;
      });

      if (threadIsActive) setMessages((current) => mergeThreadMessages(current, [message]));
    };

    const onReaction = ({ threadId, threadType, msgId, icon, senderId, senderName }: {
      threadId: string; threadType: ThreadType; msgId: string; icon: string; senderId: string; senderName: string;
    }) => {
      if (!isConversation(activeRef.current, threadId, threadType)) return;
      setMessages((current) => current.map((message) => message.id === msgId
        ? addReaction(message, icon, senderId, senderName)
        : message));
    };

    sock.on("message", onMessage);
    sock.on("message_reaction", onReaction);
    void loadConversations();
    void loadConversations("User");
    void loadConversations("Group");
    return () => {
      controller.abort();
      sock.off("message", onMessage);
      sock.off("message_reaction", onReaction);
      sock.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const { id: threadId, type: threadType } = active;
    const controller = new AbortController();
    const { signal } = controller;

    const loadMessages = async (url: string, history = false) => {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (signal.aborted || activeRef.current !== active || !Array.isArray(data.messages)) return;
        const messages = (data.messages as ChatMessage[]).filter((message) =>
          message?.threadId === threadId && message.threadType === threadType);
        if (messages.length > 0) {
          setMessages((current) => mergeThreadMessages(current, messages, history));
        }
      } catch (error) {
        if (!signal.aborted) console.error(history ? "Không thể tải lịch sử nhóm:" : "Không thể tải tin nhắn:", error);
      }
    };

    const encodedThreadId = encodeURIComponent(threadId);
    void loadMessages(`/api/chat/messages?threadId=${encodedThreadId}&threadType=${threadType}`);
    if (threadType === "Group") {
      void loadMessages(`/api/chat/history?groupId=${encodedThreadId}&count=50`, true);
    }

    void fetch("/api/chat/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, threadType }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((error) => console.error("Không thể đánh dấu đã đọc:", error));

    return () => controller.abort();
  }, [active]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSelectConversation = (conversation: Conversation | null) => {
    if (conversation && isConversation(activeRef.current, conversation.id, conversation.type)) return;
    const selected = conversation && { ...conversation };
    activeRef.current = selected;
    setActive(selected);
    setMessages([]);
    setHoveredMsgId(null);
    if (selected) {
      setConversations((current) => current.map((item) =>
        isConversation(item, selected.id, selected.type) ? { ...item, unread: 0 } : item));
      inputRef.current?.focus();
    }
  };

  const handleSend = async () => {
    if (!active || (!text.trim() && !pendingFile) || sending) return;
    const payload = text.trim();
    setText("");
    setSending(true);
    try {
      if (pendingFile) {
        const fileToSend = pendingFile;
        setPendingFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        const form = new FormData();
        form.append("file", fileToSend);
        form.append("threadId", active.id);
        form.append("threadType", active.type);
        if (payload) form.append("text", payload);
        const res = await fetch("/api/chat/attachment", { method: "POST", body: form });
        if (!res.ok) {
          const err = await res.json();
          console.error("Attachment send error:", err.error);
          if (payload) setText(payload);
        }
      } else {
        const res = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: active.id,
            threadType: active.type,
            text: payload,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          console.error("Send error:", err.error);
          setText(payload); // restore
        }
      }
    } catch {
      if (payload) setText(payload);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStickerSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setStickers([]); return; }
    setStickerLoading(true);
    try {
      const res = await fetch(`/api/chat/stickers?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setStickers(data.stickers ?? []);
    } catch {
      setStickers([]);
    } finally {
      setStickerLoading(false);
    }
  }, []);

  const handleSendEmoji = (emoji: string) => {
    setText((prev) => prev + emoji);
    // Switch to sticker tab and search for matching stickers
    setPickerTab("sticker");
    setStickerQuery(emoji);
    handleStickerSearch(emoji);
  };

  const handleSendSticker = async (sticker: StickerDetail) => {
    if (!active || sending) return;
    setPickerOpen(false);
    setSending(true);
    try {
      await fetch("/api/chat/send-sticker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: active.id,
          threadType: active.type,
          id: sticker.id,
          cateId: sticker.cateId,
          type: sticker.type,
        }),
      });
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  const handleAddTemplate = async () => {
    if (!newKeyword.trim() || !newTitle.trim()) return;
    setAddingTemplate(true);
    setAddTemplateError(null);
    try {
      await addTemplate(newKeyword.trim(), newTitle.trim());
      setNewKeyword("");
      setNewTitle("");
      setShowAddForm(false);
    } catch (err) {
      setAddTemplateError(err instanceof Error ? err.message : "Không thể thêm mẫu");
    } finally {
      setAddingTemplate(false);
    }
  };

  const handleAddReaction = async (msg: ChatMessage, icon: string) => {
    if (!active) return;
    setHoveredMsgId(null);
    await fetch("/api/chat/reaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        icon,
        messageId: msg.id,
        cliMsgId: msg.cliMsgId ?? msg.id,
        threadId: active.id,
        threadType: active.type,
      }),
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setPendingFile(file);
  };

  const handleForwardConfirm = async (targetConv: Conversation) => {
    if (!forwardingMessage) return;
    try {
      await fetch("/api/chat/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageContent: forwardingMessage.content,
          messageId: forwardingMessage.id,
          messageTs: forwardingMessage.ts,
          targetThreadId: targetConv.id,
          targetThreadType: targetConv.type,
        }),
      });
      setForwardSuccess(true);
      setTimeout(() => {
        setForwardingMessage(null);
        setForwardSearch("");
        setForwardSuccess(false);
      }, 1200);
    } catch {
      // ignore
    }
  };

  const handleCreatePoll = async () => {
    if (!active || !pollQuestion.trim()) return;
    const validOptions = pollOptions.filter((o) => o.trim());
    if (validOptions.length < 2) return;
    setPollCreating(true);
    try {
      await fetch("/api/chat/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: pollQuestion.trim(),
          options: validOptions,
          groupId: active.id,
          allowMultiChoices: pollMultiChoice,
          isAnonymous: pollAnonymous,
        }),
      });
      setShowPollModal(false);
      setPollQuestion("");
      setPollOptions(["", ""]);
      setPollMultiChoice(false);
      setPollAnonymous(false);
    } catch {
      // ignore
    } finally {
      setPollCreating(false);
    }
  };

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [pickerOpen]);

  useEffect(() => {
    if (!templateOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (templatePanelRef.current && !templatePanelRef.current.contains(e.target as Node)) {
        setTemplateOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [templateOpen]);

  // Debounced sticker search — fires 400ms after user stops typing
  useEffect(() => {
    const id = setTimeout(() => handleStickerSearch(stickerQuery), 400);
    return () => clearTimeout(id);
  }, [stickerQuery, handleStickerSearch]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("zalo_session");
    router.replace("/login");
  };

  const sidebarStatus = listStatus[tab === "group" ? "Group" : "User"];
  const filteredConvs = conversations.filter((c) => {
    const matchTab = tab === "group" ? c.type === "Group" : c.type === "User";
    const matchSearch =
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.id.includes(search);
    return matchTab && matchSearch;
  });

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return formatTime(ts);
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-gray-50">
      {/* Header */}
      <header className={`bg-white border-b border-gray-200 px-3 sm:px-4 py-3 items-center justify-between shrink-0 ${active ? "hidden md:flex" : "flex"}`}>
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center">
              <span className="text-white font-bold text-xs">Z</span>
            </div>
            <span className="font-bold text-gray-800">YAN Zalo</span>
          </div>
          <nav className="flex gap-1 items-center">
            <a
              href="/tien-ich"
              className="text-sm px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100"
            >
              Tiện ích
            </a>
            <span className="text-sm px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 font-medium">
              Chat
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/zack-the-worker/yan-zalo-web"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:block text-gray-400 hover:text-gray-700 transition-colors"
            title="GitHub"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.004.071 1.532 1.032 1.532 1.032.892 1.529 2.341 1.087 2.91.832.091-.647.35-1.087.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.748-1.025 2.748-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.744 0 .267.18.579.688.481C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
          </a>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-red-500 transition-colors"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar */}
        <aside className={`${active ? "hidden md:flex" : "flex"} w-full md:w-72 bg-white border-r border-gray-200 flex-col shrink-0 min-h-0`}>
          {/* Search */}
          <div className="p-3 border-b border-gray-100">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm kiếm..."
              className="w-full text-base md:text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-100">
            {(["direct", "group"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 text-sm py-2.5 font-medium transition-colors ${
                  tab === t
                    ? "text-blue-600 border-b-2 border-blue-500"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t === "direct" ? "Bạn bè" : "Nhóm"}
              </button>
            ))}
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto">
            {filteredConvs.length === 0 && (
              <p role="status" className="text-center text-gray-400 text-sm py-8">
                {sidebarStatus === "loading" ? (tab === "group" ? "Đang tải nhóm…" : "Đang tải bạn bè…")
                  : sidebarStatus === "error" ? (tab === "group" ? "Không thể tải nhóm" : "Không thể tải bạn bè")
                  : search ? "Không tìm thấy" : "Chưa có tin nhắn"}
              </p>
            )}
            {filteredConvs.map((conv) => (
              <button
                key={conversationKey(conv.id, conv.type)}
                onClick={() => handleSelectConversation(conv)}
                className={`w-full flex items-center gap-3 px-3 py-3 hover:bg-gray-50 text-left transition-colors ${
                  isConversation(active, conv.id, conv.type) ? "bg-blue-50" : ""
                }`}
              >
                {/* Avatar */}
                <div className="relative shrink-0" aria-hidden="true">
                  {conv.avatar ? (
                    <img
                      src={conv.avatar}
                      alt={conv.name}
                      className="w-11 h-11 rounded-full object-cover"
                    />
                  ) : (
                    <div
                      className={`w-11 h-11 rounded-full flex items-center justify-center text-white font-semibold text-sm ${
                        conv.type === "Group" ? "bg-green-500" : "bg-blue-400"
                      }`}
                    >
                      {conv.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  {conv.type === "Group" && (
                    <span className="absolute -bottom-0.5 -right-0.5 bg-green-500 text-white text-[9px] rounded px-0.5">
                      G
                    </span>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-sm truncate ${
                        conv.unread > 0 ? "font-bold text-gray-900" : "font-medium text-gray-700"
                      }`}
                    >
                      {conv.name}
                    </span>
                    {conv.lastMessage && (
                      <span className="text-xs text-gray-400 flex-shrink-0 ml-1">
                        {formatDate(conv.lastMessage.ts)}
                      </span>
                    )}
                  </div>
                  {conv.lastMessage && (
                    <p
                      className={`text-xs truncate mt-0.5 ${
                        conv.unread > 0 ? "text-gray-800 font-medium" : "text-gray-400"
                      }`}
                    >
                      {conv.lastMessage.isSelf ? "Bạn: " : ""}
                      {conv.lastMessage.mediaType === "sticker"
                        ? "[Sticker]"
                        : conv.lastMessage.content || (conv.lastMessage.mediaType === "image" ? "[Hình ảnh]" : conv.lastMessage.mediaType === "video" ? "[Video]" : "")}
                    </p>
                  )}
                </div>

                {/* Unread badge */}
                {conv.unread > 0 && (
                  <span className="flex-shrink-0 bg-blue-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {conv.unread > 9 ? "9+" : conv.unread}
                  </span>
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Chat area */}
        <main className={`${active ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col overflow-hidden`}>
          {!active ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-400">
                <MessageSquare className="w-12 h-12 text-gray-300 mb-3 mx-auto" />
                <p className="text-lg font-medium">Chọn một cuộc trò chuyện</p>
                <p className="text-sm mt-1">để bắt đầu chat</p>
              </div>
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div className="bg-white border-b border-gray-200 px-3 sm:px-5 py-3 flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => handleSelectConversation(null)} className="md:hidden w-11 h-11 -ml-2 flex items-center justify-center rounded-xl text-gray-600" aria-label="Quay lại danh sách hội thoại">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                {active.avatar ? (
                  <img
                    src={active.avatar}
                    alt={active.name}
                    className="w-9 h-9 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm ${
                      active.type === "Group" ? "bg-green-500" : "bg-blue-400"
                    }`}
                  >
                    {active.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-gray-800 text-sm truncate">{active.name}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {active.type === "Group" ? "Nhóm" : "Bạn bè"} • {active.id}
                  </p>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
                {messages.length === 0 && (
                  <p className="text-center text-gray-400 text-sm py-8">
                    Chưa có tin nhắn nào. Bắt đầu trò chuyện!
                  </p>
                )}
                {messages.map((msg) => (
                  <div
                    key={`${active.type}:${active.id}:${msg.id}`}
                    className={`flex ${msg.isSelf ? "justify-end" : "justify-start"}`}
                    onMouseEnter={() => setHoveredMsgId(msg.id)}
                    onMouseLeave={() => setHoveredMsgId(null)}
                  >
                    <div className="relative min-w-0 max-w-xs lg:max-w-md xl:max-w-lg">
                    <div
                      className={`${
                        msg.isSelf ? "items-end" : "items-start"
                      } flex flex-col`}
                    >
                      {!msg.isSelf && active.type === "Group" && (
                        <span className="text-xs text-gray-500 mb-1 ml-1">
                          {msg.fromName}
                        </span>
                      )}
                      <div
                        className={`${
                          msg.mediaType === "sticker"
                            ? ""
                            : `max-w-full min-w-0 px-4 py-2.5 rounded-2xl text-sm break-words ${
                                msg.isSelf
                                  ? "bg-blue-500 text-white rounded-br-sm"
                                  : "bg-white text-gray-800 border border-gray-200 rounded-bl-sm shadow-sm"
                              }`
                        }`}
                      >
                        {msg.mediaType === "sticker" ? (
                          msg.mediaUrl ? (
                            <Image
                              src={msg.mediaUrl}
                              alt="sticker"
                              width={96}
                              height={96}
                              unoptimized
                              className="w-24 h-24 object-contain"
                            />
                          ) : (
                            <ImageOff className="w-6 h-6 text-gray-500" aria-label="Sticker không khả dụng" />
                          )
                        ) : msg.mediaType === "file" ? (
                          <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="underline flex items-center gap-1">
                            <Paperclip className="w-3 h-3" /> {msg.content}
                          </a>
                        ) : msg.mediaType === "image" || msg.mediaType === "video" ? (
                          <ArchivedMedia mediaType={msg.mediaType} mediaUrl={msg.mediaUrl} content={msg.content} />
                        ) : (
                          msg.content
                        )}
                      </div>

                      {/* Reaction pills */}
                      {msg.reactions && msg.reactions.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1 ml-1">
                          {msg.reactions.map((r) => (
                            <span
                              key={r.icon}
                              className="flex items-center gap-0.5 text-xs bg-gray-100 rounded-full px-2 py-0.5"
                              title={r.senderNames.join(", ")}
                            >
                              {REACTION_ICONS[r.icon] ?? r.icon} {r.senderIds.length}
                            </span>
                          ))}
                        </div>
                      )}

                      <span className="text-xs text-gray-400 mt-1 mx-1">
                        {formatTime(msg.ts)}
                      </span>
                    </div>

                    {/* Hover action bar — reaction picker + forward */}
                    {hoveredMsgId === msg.id && (
                      <div
                        className={`absolute top-0 flex items-center gap-1 bg-white border border-gray-200 shadow-lg rounded-full px-2 py-1 z-10 ${
                          msg.isSelf ? "right-full mr-2" : "left-full ml-2"
                        }`}
                      >
                        {REACTION_SHORTCODES.map((code) => (
                          <button
                            key={code}
                            onClick={() => handleAddReaction(msg, code)}
                            className="text-base hover:scale-125 transition-transform leading-none"
                            title={code}
                          >
                            {REACTION_ICONS[code]}
                          </button>
                        ))}
                        <div className="w-px h-4 bg-gray-200 mx-0.5" />
                        <button
                          onClick={() => { setForwardingMessage(msg); setForwardSearch(""); setForwardSuccess(false); }}
                          className="text-gray-400 hover:text-blue-500 transition-colors"
                          title="Chuyển tiếp"
                        >
                          <Forward className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="relative bg-white border-t border-gray-200 px-2 sm:px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:py-3 flex flex-wrap items-end gap-1 sm:gap-2 shrink-0">
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileChange}
                />

                {/* File attachment button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
                  title="Đính kèm file"
                >
                  <Paperclip className="w-5 h-5" />
                </button>

                {/* Poll button (group-only) */}
                <button
                  onClick={() => { if (active?.type === "Group") setShowPollModal(true); }}
                  disabled={active?.type !== "Group"}
                  className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                  title={active?.type === "Group" ? "Tạo bình chọn" : "Chỉ dùng trong nhóm"}
                >
                  <BarChart2 className="w-5 h-5" />
                </button>
                {/* Quick message template panel */}
                <div className="relative flex-shrink-0">
                  <button
                    onClick={() => {
                      setPickerOpen(false);
                      setTemplateOpen((o) => !o);
                    }}
                    className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
                      templateOpen
                        ? "text-blue-500 bg-blue-50"
                        : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                    }`}
                    title="Tin nhắn mẫu"
                  >
                    <BookMarked className="w-5 h-5" />
                  </button>

                  {templateOpen && (
                    <div
                      ref={templatePanelRef}
                      className="fixed bottom-28 left-2 right-2 sm:absolute sm:bottom-12 sm:left-0 sm:right-auto sm:w-80 bg-white border border-gray-200 rounded-2xl shadow-2xl overflow-hidden z-50"
                    >
                      {/* Panel header */}
                      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
                        <span className="text-sm font-semibold text-gray-700">Tin nhắn mẫu</span>
                        <button
                          onClick={() => { setShowAddForm((s) => !s); setAddTemplateError(null); }}
                          className="text-gray-400 hover:text-blue-500 transition-colors"
                          title="Thêm mẫu"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Add form */}
                      {showAddForm && (
                        <div className="p-3 border-b border-gray-100 space-y-2 bg-gray-50">
                          <input
                            type="text"
                            value={newKeyword}
                            onChange={(e) => setNewKeyword(e.target.value)}
                            placeholder="Từ khóa (VD: hello)"
                            className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
                          />
                          <textarea
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            placeholder="Nội dung tin nhắn mẫu"
                            rows={2}
                            className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
                          />
                          {addTemplateError && (
                            <p className="text-xs text-red-500">{addTemplateError}</p>
                          )}
                          <button
                            onClick={handleAddTemplate}
                            disabled={addingTemplate || !newKeyword.trim() || !newTitle.trim()}
                            className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white text-xs font-medium py-2 rounded-lg transition-colors"
                          >
                            {addingTemplate ? "Đang lưu..." : "Lưu mẫu"}
                          </button>
                        </div>
                      )}

                      {/* Template list */}
                      <div className="max-h-56 overflow-y-auto">
                        {templatesLoading && (
                          <div className="flex justify-center py-4">
                            <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        {!templatesLoading && templates.length === 0 && (
                          <p className="text-center text-gray-400 text-xs py-6">
                            Chưa có mẫu nào. Nhấn + để thêm.
                          </p>
                        )}
                        {templates.map((t) => (
                          <button
                            key={t.id}
                            onClick={() => {
                              setText(t.message.title);
                              setTemplateOpen(false);
                              inputRef.current?.focus();
                            }}
                            className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
                          >
                            <p className="text-xs font-medium text-blue-600">/{t.keyword}</p>
                            <p className="text-sm text-gray-700 mt-0.5 line-clamp-2">{t.message.title}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Emoji / Sticker picker */}
                <div className="relative flex-shrink-0" ref={pickerRef}>
                  <button
                    onClick={() => {
                      setTemplateOpen(false);
                      setPickerOpen((o) => {
                        if (!o) {
                          // Reset sticker search when opening
                          setStickerQuery("");
                          setStickers([]);
                        }
                        return !o;
                      });
                    }}
                    className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
                      pickerOpen
                        ? "text-blue-500 bg-blue-50"
                        : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                    }`}
                    title="Emoji & Sticker"
                  >
                    <Smile className="w-6 h-6" />
                  </button>

                  {pickerOpen && (
                    <div className="fixed bottom-28 left-2 right-2 sm:absolute sm:bottom-12 sm:left-0 sm:right-auto sm:w-80 bg-white border border-gray-200 rounded-2xl shadow-2xl overflow-hidden z-50">
                      {/* Picker tabs */}
                      <div className="flex border-b border-gray-100">
                        <button
                          onClick={() => setPickerTab("emoji")}
                          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                            pickerTab === "emoji"
                              ? "text-blue-600 border-b-2 border-blue-500"
                              : "text-gray-500 hover:text-gray-700"
                          }`}
                        >
                          😀 Emoji
                        </button>
                        <button
                          onClick={() => setPickerTab("sticker")}
                          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                            pickerTab === "sticker"
                              ? "text-blue-600 border-b-2 border-blue-500"
                              : "text-gray-500 hover:text-gray-700"
                          }`}
                        >
                          🖼 Sticker
                        </button>
                      </div>

                      {/* Emoji tab */}
                      {pickerTab === "emoji" && (
                        <div className="p-3 grid grid-cols-8 gap-1 max-h-56 overflow-y-auto">
                          {EMOJI_GROUPS.map((emoji) => (
                            <button
                              key={emoji}
                              onClick={() => handleSendEmoji(emoji)}
                              className="text-2xl w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Sticker tab */}
                      {pickerTab === "sticker" && (
                        <div className="flex flex-col">
                          <div className="p-2 border-b border-gray-100">
                            <input
                              type="text"
                              value={stickerQuery}
                              onChange={(e) => setStickerQuery(e.target.value)}
                              placeholder="Tìm sticker..."
                              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
                              autoFocus
                            />
                          </div>
                          <div className="p-2 grid grid-cols-4 gap-2 max-h-52 overflow-y-auto">
                            {stickerLoading && (
                              <div className="col-span-4 flex justify-center py-4">
                                <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                              </div>
                            )}
                            {!stickerLoading && stickers.length === 0 && stickerQuery && (
                              <p className="col-span-4 text-center text-gray-400 text-xs py-4">
                                Không tìm thấy sticker
                              </p>
                            )}
                            {!stickerLoading && stickers.length === 0 && !stickerQuery && (
                              <p className="col-span-4 text-center text-gray-400 text-xs py-4">
                                Nhập từ khóa để tìm sticker
                              </p>
                            )}
                            {stickers.map((s) => (
                              <button
                                key={s.id}
                                onClick={() => handleSendSticker(s)}
                                className="rounded-xl overflow-hidden hover:bg-gray-100 p-1 transition-colors"
                                title={s.text}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={s.stickerWebpUrl || s.stickerUrl}
                                  alt={s.text}
                                  className="w-14 h-14 object-contain mx-auto"
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="w-full order-first sm:order-none sm:w-auto sm:flex-1 min-w-0 flex flex-col gap-1">
                  {pendingFile && (
                    <div className="flex items-center gap-2 px-1">
                      <Paperclip className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                      <span className="text-xs text-gray-600 truncate flex-1">{pendingFile.name}</span>
                      <button
                        onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                        className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0 text-sm leading-none"
                        title="Xóa file"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)"
                    rows={1}
                    className="flex-1 resize-none text-base sm:text-sm border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-300 max-h-32 overflow-y-auto"
                    style={{ minHeight: "44px" }}
                  />
                </div>
                <button
                  onClick={handleSend}
                  disabled={(!text.trim() && !pendingFile) || sending}
                  className="ml-auto sm:ml-0 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white px-5 py-3 rounded-xl text-sm font-medium transition-colors shrink-0"
                >
                  {sending ? "..." : "Gửi"}
                </button>
              </div>
            </>
          )}
        </main>
      </div>

      {/* Forward Message Modal */}
      {forwardingMessage && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setForwardingMessage(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-96 max-h-[80dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-800">Chuyển tiếp tin nhắn</h3>
              <button onClick={() => setForwardingMessage(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            {forwardSuccess ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <p className="text-green-600 font-medium">✓ Đã chuyển tiếp!</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
                  <p className="text-xs text-gray-500 truncate">"{forwardingMessage?.content}"</p>
                </div>
                <div className="px-4 py-2 border-b border-gray-100">
                  <input
                    type="text"
                    value={forwardSearch}
                    onChange={(e) => setForwardSearch(e.target.value)}
                    placeholder="Tìm cuộc trò chuyện..."
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    autoFocus
                  />
                </div>
                <div className="flex-1 overflow-y-auto">
                  {conversations
                    .filter((c) => !forwardSearch || c.name.toLowerCase().includes(forwardSearch.toLowerCase()))
                    .map((conv) => (
                      <button
                        key={conversationKey(conv.id, conv.type)}
                        onClick={() => handleForwardConfirm(conv)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
                      >
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0 ${conv.type === "Group" ? "bg-green-500" : "bg-blue-400"}`}>
                          {conv.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{conv.name}</p>
                          <p className="text-xs text-gray-400">{conv.type === "Group" ? "Nhóm" : "Bạn bè"}</p>
                        </div>
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Poll Creation Modal */}
      {showPollModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowPollModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-96 max-h-[90dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-800">Tạo bình chọn</h3>
              <button onClick={() => setShowPollModal(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Câu hỏi</label>
                <input
                  type="text"
                  value={pollQuestion}
                  onChange={(e) => setPollQuestion(e.target.value)}
                  placeholder="Nhập câu hỏi bình chọn..."
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Các lựa chọn (tối thiểu 2)</label>
                <div className="space-y-2">
                  {pollOptions.map((opt, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => { const next = [...pollOptions]; next[i] = e.target.value; setPollOptions(next); }}
                        placeholder={`Lựa chọn ${i + 1}`}
                        className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
                      />
                      {pollOptions.length > 2 && (
                        <button onClick={() => setPollOptions(pollOptions.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500 text-sm px-1">✕</button>
                      )}
                    </div>
                  ))}
                  {pollOptions.length < 10 && (
                    <button onClick={() => setPollOptions([...pollOptions, ""])} className="text-sm text-blue-500 hover:text-blue-600 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Thêm lựa chọn
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={pollMultiChoice} onChange={(e) => setPollMultiChoice(e.target.checked)} className="rounded" />
                  <span className="text-sm text-gray-700">Cho phép chọn nhiều đáp án</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={pollAnonymous} onChange={(e) => setPollAnonymous(e.target.checked)} className="rounded" />
                  <span className="text-sm text-gray-700">Bình chọn ẩn danh</span>
                </label>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100">
              <button
                onClick={handleCreatePoll}
                disabled={pollCreating || !pollQuestion.trim() || pollOptions.filter((o) => o.trim()).length < 2}
                className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                {pollCreating ? "Đang tạo..." : "Tạo bình chọn"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
