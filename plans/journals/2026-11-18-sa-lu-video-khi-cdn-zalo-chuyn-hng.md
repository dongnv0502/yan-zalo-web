---
title: Sửa lưu video khi CDN Zalo chuyển hướng
date: 2026-11-18
summary: Cho phép chuyển hướng HTTPS trong danh sách CDN Zalo trước khi lưu RustFS.
---

# Sửa lưu video khi CDN Zalo chuyển hướng

## Nguyên nhân và bản sửa

`lib/chatMedia.ts` từ chối mọi chuyển hướng khi tải nguồn; tin vẫn lưu nhưng không có URL media nếu CDN trả 302. Đổi sang theo tối đa ba chuyển hướng, kiểm tra từng đích trước khi gửi request và giữ nguyên xác thực phát media.

## Kiểm chứng

Test hồi quy đỏ trước sửa; sau sửa 75 test liên quan và TypeScript qua. Fixture 302 + MP4 công khai qua luồng lưu thật vào RustFS cục bộ; trình phát Chrome trên trang kiểm thử nhận HTTP 206, phát và tua. Không xác minh video người dùng hoặc triển khai production.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
