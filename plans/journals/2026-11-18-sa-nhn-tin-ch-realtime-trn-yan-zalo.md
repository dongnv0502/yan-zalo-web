---
title: Sửa nhận tin chữ realtime trên Yan Zalo
date: 2026-11-18
summary: Xử lý đối số null từ Socket.io để tin chữ xuất hiện không cần tải lại.
---

# Sửa nhận tin chữ realtime trên Yan Zalo

## Nguyên nhân và bản sửa

Socket.io mã hóa đối số tùy chọn `undefined` thành `null`; callback `/chat` giải cấu trúc đối số và ném lỗi sau khi server đã lưu tin. Sự kiện cập nhật ảnh mang object nên vẫn hiển thị. `app/chat/page.tsx` đọc tùy chọn theo cách chấp nhận cả `null` lẫn đối số vắng mặt, giữ nguyên cách gộp và cập nhật media.

## Kiểm chứng

Test hồi quy thất bại trước sửa; sau sửa 19 test `/chat` và TypeScript đều qua. Chrome với dữ liệu tổng hợp và Socket.io thật hiển thị tin chữ, nhận cập nhật ảnh, không gọi lại API lịch sử. Không dùng tài khoản Zalo thật, không triển khai.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
