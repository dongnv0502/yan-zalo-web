export type AppSection = "chat" | "tools";

export interface MobileNavProps {
  section: AppSection;
  onChatList?: () => void;
  isToolDetail?: boolean;
}

export interface AppHeaderProps {
  section: AppSection;
  onLogout: () => void;
  hideOnMobile?: boolean;
  isToolDetail?: boolean;
}

export interface ToolDirectoryProps {
  currentPath?: string;
}
