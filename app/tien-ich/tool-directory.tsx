import Link from "next/link";
import { ChevronRight, ClipboardList, Clock, Link2, Search, Users, UserSearch, Users2 } from "lucide-react";
import type { ToolDirectoryProps } from "@/types/navigation";

const tools = [
  { href: "/tien-ich/scan-group-members", Icon: Search, label: "Quét thành viên nhóm", description: "Lấy danh sách thành viên và xuất CSV/JSON" },
  { href: "/tien-ich/last-online", Icon: Clock, label: "Tra cứu giờ online", description: "Xem thời điểm hoạt động gần nhất" },
  { href: "/tien-ich/group-events", Icon: ClipboardList, label: "Log sự kiện nhóm", description: "Theo dõi thành viên vào/ra nhóm theo thời gian thực" },
  { href: "/tien-ich/friend-recs", Icon: Users, label: "Gợi ý kết bạn", description: "Xem Zalo đang gợi ý ai và lý do" },
  { href: "/tien-ich/find-user", Icon: UserSearch, label: "Tra cứu tài khoản", description: "Tìm thông tin công khai qua số điện thoại" },
  { href: "/tien-ich/related-friend-group", Icon: Users2, label: "Nhóm chung", description: "Xem các nhóm chung với người khác" },
  { href: "/tien-ich/parse-link", Icon: Link2, label: "Phân tích liên kết", description: "Xem tiêu đề, mô tả và metadata của URL" },
] as const;

export function ToolDirectory({ currentPath }: ToolDirectoryProps) {
  return (
    <nav aria-label="Danh sách tiện ích">
      <ul className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 md:gap-1">
        {tools.map(({ href, Icon, label, description }) => {
          const selected = currentPath === href;
          return (
            <li key={href} className="min-w-0">
              <Link href={href} aria-current={selected ? "page" : undefined} className={`flex h-full min-h-16 items-center gap-3 rounded-xl border px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-blue-600 md:items-start md:border-transparent ${selected ? "border-blue-100 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-800 hover:bg-gray-50"}`}>
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700 md:size-5 md:bg-transparent">
                  <Icon aria-hidden="true" className="w-5 h-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-gray-600">{description}</span>
                </span>
                <ChevronRight aria-hidden="true" className="w-4 h-4 shrink-0 text-gray-500 md:hidden" />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
