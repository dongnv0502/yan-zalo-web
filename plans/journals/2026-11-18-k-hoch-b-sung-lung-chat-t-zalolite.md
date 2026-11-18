---
title: Kế hoạch bổ sung luồng chat từ Zalolite
date: 2026-11-18
summary: "Chọn tìm tin đã lưu, trả lời trích dẫn và thu hồi; giữ Next.js, zca-js và SQLite."
---

# Kế hoạch bổ sung luồng chat từ Zalolite

## Thay đổi

Đối chiếu Zalolite v0.0.14 với `/chat`, SQLite và zca-js 2.1.2. Tạo kế hoạch `plans/261118-0408-zalo-chat-parity/plan.md`; không thay đổi code ứng dụng.

## Quyết định

Dùng chung điểm nhảy vào lịch sử cho tìm tin và trích dẫn. Metadata gửi quote ở server. Thu hồi chỉ xác nhận theo sự kiện đúng định danh; thứ tự ACK, history và media không được khôi phục nội dung đã thu hồi. Không đưa worker Rust hay dữ liệu thật sang dự án web.

## Kiểm chứng

CLI xác nhận cấu trúc kế hoạch. Smoke SQLite in-memory xác nhận đối sánh Unicode và phạm vi tài khoản. Còn cổng nghiệm thu tương tác và hợp đồng Zalo thật khi triển khai; không kết nối tài khoản từ phiên lập kế hoạch.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
