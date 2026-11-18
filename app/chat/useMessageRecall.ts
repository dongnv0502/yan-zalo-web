import { useCallback, useRef, useState } from "react";
import type { ChatMessage, ChatMessageKey, ThreadType } from "@/types/chat";

export const RECALLED = "Tin nhắn đã được thu hồi";
export const messageKey = (threadId: string, threadType: ThreadType, id: string) => JSON.stringify([threadType, threadId, id]);

const globalRecallKey = (key: string) => `global:${key}`;
export function redactMessage(message: ChatMessage, recalled: ReadonlySet<string>): ChatMessage {
  const { threadId, threadType, id, fromId, fromName, isSelf, ts } = message;
  if (message.recalled || recalled.has(messageKey(threadId, threadType, id))) {
    return { threadId, threadType, id, fromId, fromName, isSelf, ts, recalled: true, content: RECALLED };
  }
  const target = message.quote?.targetId;
  const key = target && messageKey(threadId, threadType, target);
  return target && key && recalled.has(message.quote?.targetUnavailable ? globalRecallKey(key) : key)
    ? { ...message, quote: { targetId: target, text: RECALLED } } : message;
}

export function useMessageRecall(onEvent: (target: ChatMessageKey) => void) {
  const [recalled, setRecalled] = useState<ReadonlySet<string>>(() => new Set());
  const confirmed = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ key: string; threadId: string; threadType: ThreadType; text: string }>();
  const onRecall = useCallback((target: ChatMessageKey) => {
    const localKey = messageKey(target.threadId, target.threadType, target.messageId);
    const key = target.namespace === "global" ? globalRecallKey(localKey) : localKey;
    if (confirmed.current.has(key)) return;
    confirmed.current.add(key);
    setRecalled((current) => new Set(current).add(key));
    setNotice((current) => current?.key === key ? undefined : current);
    if (!target.namespace) onEvent(target);
  }, [onEvent]);
  const recall = async (message: ChatMessage) => {
    const { threadId, threadType, id: messageId } = message;
    const key = messageKey(threadId, threadType, messageId);
    if (inFlight.current.has(key) || confirmed.current.has(key) || !globalThis.confirm("Thu hồi tin nhắn này trên Zalo?")) return;
    inFlight.current.add(key);
    setPending((current) => new Set(current).add(key));
    setNotice(undefined);
    const target = { threadId, threadType, messageId };
    const report = (text: string) => {
      if (!confirmed.current.has(key)) setNotice({ key, threadId, threadType, text });
    };
    try {
      let response: Response | undefined;
      try {
        response = await fetch("/api/chat/recall", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target), signal: AbortSignal.timeout(6000),
        });
      } catch {
        // An upstream operation may complete after the request times out.
      }
      if (confirmed.current.has(key)) return;
      if (!response || response.status === 202) {
        report("Đang chờ xác nhận thu hồi…");
        const { promise: delay, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 5000);
        await delay;
        if (confirmed.current.has(key)) return;
        const params = new URLSearchParams({ threadId, threadType, around: messageId });
        const state = await fetch(`/api/chat/messages?${params}`, { signal: AbortSignal.timeout(5000) });
        if (state.ok && ((await state.json()).messages as ChatMessage[]).some((item) => item.id === messageId && item.recalled)) onRecall(target);
        else report("Chưa xác nhận thu hồi.");
      } else if (response.ok) onRecall(target);
      else report((await response.json()).error || "Không thu hồi được tin nhắn.");
    } catch {
      report("Chưa xác nhận thu hồi.");
    } finally {
      inFlight.current.delete(key);
      setPending((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  return { recalled, onRecall, recall, notice, pending };
}
