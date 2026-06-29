"use client";

import { useState } from "react";
import Image from "next/image";
import type { ParseLinkResult } from "@/types/utilities";

export default function ParseLinkPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseLinkResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(
        `/api/utilities/parse-link?url=${encodeURIComponent(url.trim())}`
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Không thể phân tích liên kết");
        return;
      }
      setResult(data as ParseLinkResult);
    } catch {
      setError("Lỗi kết nối");
    } finally {
      setLoading(false);
    }
  };

  const d = result?.data;
  const hasMedia = d?.media && d.media.type !== 0;

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-800 mb-2">
        Phân tích liên kết
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Nhập URL để trích xuất metadata: tiêu đề, mô tả, ảnh thumbnail và thông
        tin media.
      </p>

      {/* Input form */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6 max-w-2xl">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="flex-1 border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
            required
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 text-white font-medium px-5 py-3 rounded-xl transition-colors text-sm whitespace-nowrap"
          >
            {loading ? "Đang phân tích..." : "Phân tích"}
          </button>
        </form>

        {error && <p className="mt-3 text-red-500 text-sm">⚠️ {error}</p>}
      </div>

      {/* Result card */}
      {d && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden max-w-2xl">
          {d.thumb && (
            <div className="relative w-full h-48 bg-gray-100">
              <Image
                src={d.thumb}
                alt={d.title || "Thumbnail"}
                fill
                className="object-cover"
                unoptimized
              />
            </div>
          )}

          <div className="p-6">
            {d.title && (
              <h2 className="font-bold text-gray-800 text-base mb-1 leading-snug">
                {d.title}
              </h2>
            )}

            {d.desc && (
              <p className="text-sm text-gray-500 mb-4 leading-relaxed">
                {d.desc}
              </p>
            )}

            {(d.href || d.src) && (
              <a
                href={d.href || d.src}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-blue-500 hover:text-blue-700 text-sm font-medium transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Mở liên kết gốc
              </a>
            )}

            {hasMedia && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                  Thông tin media
                </p>
                <div className="space-y-2">
                  {d.media.mediaTitle && (
                    <div className="flex gap-2 text-sm">
                      <span className="text-gray-400 w-20 shrink-0">Tiêu đề</span>
                      <span className="text-gray-700">{d.media.mediaTitle}</span>
                    </div>
                  )}
                  {d.media.artist && (
                    <div className="flex gap-2 text-sm">
                      <span className="text-gray-400 w-20 shrink-0">Nghệ sĩ</span>
                      <span className="text-gray-700">{d.media.artist}</span>
                    </div>
                  )}
                  {d.media.streamUrl && (
                    <div className="flex gap-2 text-sm">
                      <span className="text-gray-400 w-20 shrink-0">Stream</span>
                      <a
                        href={d.media.streamUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline truncate"
                      >
                        {d.media.streamUrl}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
