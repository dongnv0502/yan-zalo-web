---
title: "Tìm lịch sử và khóa phát hành quote, undo"
date: 2026-11-18
summary: Hoàn tất tìm tin đã lưu; quote và yêu cầu thu hồi chờ xác minh trực tiếp với Zalo.
---

# Tìm lịch sử và khóa phát hành quote, undo

## Đã thực hiện

- Bổ sung tìm kiếm SQLite theo hội thoại và cửa sổ quanh tin cũ; smoke `/chat` bằng dữ liệu tổng hợp trên desktop và 390 × 844.
- Thêm metadata SDK tách khỏi DTO, migration SQLite, xác thực Socket.io theo thế hệ phiên và tombstone thu hồi. Xác minh qua Vitest và build Next.js; lint không chạy vì thiếu ESLint.

## Cổng phát hành

- Quote và yêu cầu thu hồi mặc định tắt: chưa dùng tài khoản thật. Cần xác minh quote ở phía nhận, self-echo và self-undo trong chat 1-1/nhóm bằng tài khoản được phép.
- SDK không phân loại undo trong lịch sử nhóm; không ghi tombstone cho chỉ dấu chưa xác minh. Không deploy, không xuất bản PR.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
