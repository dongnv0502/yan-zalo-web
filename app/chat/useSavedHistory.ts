import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSearchResponse, Conversation } from "@/types/chat";

export function useSavedHistory(active: Conversation | null) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ChatSearchResponse>();
  const [index, setIndex] = useState(0);
  const [searchError, setSearchError] = useState("");
  const [jumpError, setJumpError] = useState("");
  const [window, setWindow] = useState<{ id: string; messages: ChatMessage[]; query?: string; scroll: AbortSignal }>();
  const searchRequest = useRef<AbortController>(null);
  const jumpRequest = useRef<AbortController>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const hit = useRef<HTMLDivElement>(null);

  const invalidateSearch = useCallback(() => {
    searchRequest.current?.abort();
    setResult(undefined);
    setIndex(0);
    setSearchError("");
  }, []);
  const latest = useCallback(() => {
    jumpRequest.current?.abort();
    setWindow(undefined);
    setJumpError("");
  }, []);
  const close = useCallback(() => {
    invalidateSearch();
    jumpRequest.current?.abort();
    setWindow((current) => current && { ...current, query: undefined });
    setJumpError("");
    setQuery("");
    setOpen(false);
  }, [invalidateSearch]);
  const reset = useCallback(() => { close(); latest(); }, [close, latest]);
  const suspend = useCallback(() => {
    close();
    setWindow((current) => current && { ...current, messages: [] });
  }, [close]);

  useEffect(() => {
    if (open) searchInput.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !active || !query.trim()) return;
    const request = new AbortController();
    searchRequest.current = request;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/chat/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId: active.id, threadType: active.type, q: query.trim() }),
          signal: request.signal,
        });
        if (!response.ok) throw new Error();
        const data: ChatSearchResponse = await response.json();
        if (!request.signal.aborted) setResult(data);
      } catch {
        if (!request.signal.aborted) setSearchError("Không thể tìm trong lịch sử đã lưu.");
      }
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [active, open, query]);

  useEffect(() => () => jumpRequest.current?.abort(), []);
  const scroll = window?.scroll;
  useEffect(() => {
    if (scroll && !scroll.aborted) hit.current?.scrollIntoView({ block: "center" });
  }, [scroll]);

  const jump = async (id: string, searchQuery?: string) => {
    if (!active) return;
    const request = new AbortController();
    jumpRequest.current?.abort();
    jumpRequest.current = request;
    setJumpError("");
    const params = new URLSearchParams({ threadId: active.id, threadType: active.type, around: id });
    try {
      const response = await fetch(`/api/chat/messages?${params}`, { signal: request.signal });
      if (response.status === 404) {
        if (!request.signal.aborted) setJumpError("Không có tin nhắn này trong lịch sử đã lưu.");
        return;
      }
      if (!response.ok) throw new Error();
      const data: { messages: ChatMessage[]; targetId?: string } = await response.json();
      if (!request.signal.aborted) setWindow({ id: data.targetId ?? id, messages: data.messages, query: searchQuery, scroll: request.signal });
    } catch {
      if (!request.signal.aborted) setJumpError("Không thể mở tin nhắn đã lưu.");
    }
  };

  const select = (position: number) => {
    const match = result?.results[position];
    if (!match) return;
    setIndex(position);
    void jump(match.id, query.trim());
  };

  return {
    open, setOpen, query, changeQuery: (value: string) => {
      invalidateSearch();
      jumpRequest.current?.abort();
      setQuery(value);
    }, result, index, searchError, jumpError, window, setWindow, searchInput, hit, close, reset, latest, jump, select,
    suspend,
  };
}
