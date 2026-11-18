import Link from "next/link";
import { CodeXml, MessageSquare, Wrench } from "lucide-react";
import type { AppHeaderProps, MobileNavProps } from "@/types/navigation";

const destinations = [
  { section: "chat", href: "/chat", label: "Chat", Icon: MessageSquare },
  { section: "tools", href: "/tien-ich", label: "Tiện ích", Icon: Wrench },
] as const;

export function MobileNav({ section, onChatList, isToolDetail }: MobileNavProps) {
  return (
    <nav aria-label="Điều hướng di động" className="shrink-0 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="mx-auto grid max-w-md grid-cols-2 gap-2 px-3 py-1">
        {destinations.map(({ section: destination, href, label, Icon }) => {
          const selected = section === destination;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={selected ? (isToolDetail ? "true" : "page") : undefined}
                onClick={destination === "chat" && onChatList ? (event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onChatList();
                } : undefined}
                className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${selected ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-50"}`}
              >
                <Icon aria-hidden="true" className="w-5 h-5" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppHeader({ section, onLogout, hideOnMobile, isToolDetail }: AppHeaderProps) {
  return (
    <header className={`shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-2 md:px-6 ${hideOnMobile ? "hidden md:flex" : "flex"}`}>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-blue-500 text-xs font-bold text-white">Z</span>
          <span className="font-bold text-gray-800">YAN Zalo</span>
        </div>
        <nav aria-label="Điều hướng chính" className="hidden items-center gap-1 md:flex">
          {destinations.map(({ section: destination, href, label }) => {
            const selected = destination === section;
            return (
              <Link key={href} href={href} aria-current={selected ? (isToolDetail ? "true" : "page") : undefined} className={`rounded-lg px-3 py-1.5 text-sm ${selected ? "bg-blue-50 font-medium text-blue-700" : "text-gray-600 hover:bg-gray-100"}`}>
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <a href="https://github.com/zack-the-worker/yan-zalo-web" target="_blank" rel="noopener noreferrer" aria-label="Mã nguồn trên GitHub" className="hidden size-11 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 md:grid">
          <CodeXml aria-hidden="true" className="w-5 h-5" />
        </a>
        <button type="button" onClick={onLogout} className="min-h-11 rounded-lg px-2 text-sm text-gray-600 hover:bg-red-50 hover:text-red-700">
          Đăng xuất
        </button>
      </div>
    </header>
  );
}
