export type ThreadType = "User" | "Group";
export type MediaType = "sticker" | "image" | "video" | "file" | "poll";

export interface MessageReaction {
  icon: string;
  senderIds: string[];
  senderNames: string[];
}

export interface ChatMessage {
  id: string;
  threadId: string;
  threadType: ThreadType;
  fromId: string;
  fromName: string;
  content: string;
  ts: number;
  isSelf: boolean;
  mediaType?: MediaType;
  mediaUrl?: string;
  cliMsgId?: string;
  pollId?: number;
  reactions?: MessageReaction[];
  canReply?: boolean;
  quote?: ChatQuotePreview;
  canRecall?: boolean;
  recalled?: boolean;
}

export interface ChatMessageKey {
  threadId: string;
  threadType: ThreadType;
  messageId: string;
  namespace?: "global";
}

export interface ChatQuotePreview {
  targetId?: string;
  targetUnavailable?: boolean;
  text: string;
  fromName?: string;
}

export interface ChatDraft {
  text: string;
  revision?: number;
  quote?: ChatQuotePreview;
  error?: string;
}

export interface ChatSearchResult {
  id: string;
  fromName: string;
  ts: number;
  excerpt: string;
}

export interface ChatSearchResponse {
  results: ChatSearchResult[];
  hasMore: boolean;
}

export interface Conversation {
  id: string;
  type: ThreadType;
  name: string;
  avatar?: string;
  lastMessage?: ChatMessage;
  unread: number;
}

export interface StickerDetail {
  id: number;
  cateId: number;
  type: number;
  stickerUrl: string;
  stickerWebpUrl: string | null;
  text: string;
}

export type Tab = "direct" | "group";

export type PickerTab = "emoji" | "sticker" | "poll";

export type QuickMessage = {
  id: number;
  keyword: string;
  type: number;
  createdTime: number;
  lastModified: number;
  message: {
    title: string;
    params: string | null;
  };
  media: {
    items: {
      type: number;
      photoId: number;
      title: string;
      width: number;
      height: number;
      previewThumb: string;
      rawUrl: string;
      thumbUrl: string;
      normalUrl: string;
      hdUrl: string;
    }[];
  } | null;
};

export interface PollOption {
  id: string;
  name: string;
  votes: number;
}

export interface PollDetail {
  pollId: number;
  question: string;
  options: PollOption[];
  creator: string;
  expiredTime: number;
  isLocked: boolean;
}

export interface CreatePollRequest {
  question: string;
  options: string[];
  groupId: string;
  expiredTime?: number;
  allowMultiChoices?: boolean;
  isAnonymous?: boolean;
}
