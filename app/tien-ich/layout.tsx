"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { AppHeader, MobileNav } from "../app-navigation";
import { ToolDirectory } from "./tool-directory";


export default function TienIchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);
  const isToolDetail = pathname !== "/tien-ich";

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/status");
        const d = await res.json();
        if (d.status === "logged_in") { setChecked(true); return; }
        const stored = localStorage.getItem("zalo_session");
        if (stored) {
          const restoreRes = await fetch("/api/auth/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: stored,
          });
          const restoreData = await restoreRes.json();
          if (restoreData.status === "logged_in") { setChecked(true); return; }
          localStorage.removeItem("zalo_session");
        }
        router.replace("/login");
      } catch {
        router.replace("/login");
      }
    };
    checkAuth();
  }, [router]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("zalo_session");
    router.replace("/login");
  };

  if (!checked) {
    return (
      <div role="status" className="grid min-h-dvh place-items-center bg-gray-50 text-sm text-gray-600">
        Đang tải…
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <AppHeader section="tools" onLogout={handleLogout} isToolDetail={isToolDetail} />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-gray-200 bg-white p-3 md:block">
          <p className="mb-2 px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Danh sách tiện ích</p>
          <ToolDirectory currentPath={pathname} />
        </aside>
        <main key={pathname} className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {isToolDetail && (
            <Link href="/tien-ich" className="-ml-2 mb-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-blue-700 hover:bg-blue-50 md:hidden">
              <ChevronLeft aria-hidden="true" className="w-5 h-5" />
              Tất cả tiện ích
            </Link>
          )}
          {children}
        </main>
      </div>
      <MobileNav section="tools" isToolDetail={isToolDetail} />
    </div>
  );
}
