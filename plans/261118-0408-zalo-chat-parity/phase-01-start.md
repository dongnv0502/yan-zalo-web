---
phase: 1
title: "Tìm tin trong hội thoại"
status: todo
priority: P1
dependencies: []
---

# Pha 1: Tìm tin trong hội thoại

## Mục tiêu

Tìm nội dung văn bản trong lịch sử SQLite của hội thoại đang mở, kể cả tin ngoài 200 dòng mới nhất. Chọn kết quả, hoặc dùng Enter / Shift+Enter, để nhảy tới tin và tô sáng nội dung khớp. Không tìm trên Zalo; ghi rõ “Lịch sử đã lưu”.

## Tệp sở hữu

- Sửa `lib/messageStore.ts`, `lib/messageStore.integration.test.ts`, `app/api/chat/messages/route.ts`, `app/chat/page.tsx`, `app/chat/page.test.tsx`, `types/chat.ts`, `README.md`.
- Tạo `app/api/chat/search/route.ts`, `app/api/chat/search/route.test.ts`, `app/api/chat/messages/route.test.ts`. Không xóa tệp.

## Triển khai (Red → Green → Refactor)

- [x] Viết test SQLite với hơn 200 tin, thời gian trùng nhau, chuỗi có `%`/`_`, chữ hoa tiếng Việt, tài khoản và loại hội thoại trùng ID. Thêm test API 401/400, phạm vi và `private, no-store`; thêm test UI cho kết quả đến muộn và thao tác bàn phím.
- [x] Thêm `POST /api/chat/search` chỉ đọc, JSON `{ threadType, threadId, q }` để từ khóa chat không vào URL/access logs; không log body. Xác thực theo cookie như `/api/chat/messages`; lấy `accountId` bằng `api.getOwnId()`. Với schema hiện tại, tìm phần `content` hiển thị của tin không có `mediaType`, không tìm raw JSON hay metadata đính kèm; một số nội dung từ trước chưa phân loại vẫn có thể khớp. Dùng cùng quy tắc NFC + lowercase Unicode trên search lẫn highlight, theo chuỗi con literal, vẫn phân biệt dấu. Ràng buộc `q` 1–200 ký tự sau trim; trả 100 kết quả mới nhất theo `(ts, message_id)` và `hasMore` từ hàng 101; mỗi hàng chỉ gồm ID, tác giả, thời gian và đoạn trích không quá 200 ký tự có ngữ cảnh quanh match. Dùng truy vấn có tham số, tận dụng index phạm vi sẵn có; dùng hàm SQLite đăng ký bằng `DatabaseSync.function` trên `json_extract` thay cho `lower()` mặc định chỉ xử lý ASCII. Đo p95 dưới 200 ms với 10.000 tin trong một hội thoại trên máy dev; đo cả ca không có kết quả; nếu không đạt, xem lại phương án chỉ mục, không cắt lịch sử âm thầm.
- [x] Mở rộng `GET /api/chat/messages` với `around=<messageId>` (không đổi hợp đồng khi không có `around`). Truy vấn tâm theo khóa đầy đủ, hai phía theo `(ts, message_id)` (tối đa 25 mỗi bên) trong cùng snapshot đọc, trả theo thứ tự cũ → mới. Trả 404 nếu không còn tâm trong phạm vi. Không truyền dữ liệu lịch sử sang request Zalo; giữ `getMessages()` và luồng group-history cũ.
- [x] Trong `/chat`, giữ cửa sổ cũ ở state riêng, không trộn hai đoạn lịch sử rời nhau thành một timeline. Có nút “Về tin mới nhất”; Socket.io vẫn cập nhật timeline mới nhất và danh sách hội thoại, chỉ áp cập nhật đúng ID lên những tin đã hiện ở cửa sổ cũ. Chờ DOM render rồi cuộn tới đúng ID; chỉ auto-scroll cuối ở chế độ mới nhất khi phù hợp. Debounce tìm và dùng thế hệ request độc lập cho tìm/nhảy; hủy request cũ, kiểm tra thế hệ + hội thoại, không để hai lần nhảy cùng thread cập nhật sai thứ tự. Hiển thị `n/N` cho tập trả về; ghi “100 kết quả mới nhất” khi `hasMore`. Highlight bằng text nodes, không dùng HTML nội suy. Escape đóng tìm kiếm; nút tìm có nhãn truy cập và dùng Lucide.
- [x] “Về tin mới nhất”, đổi hội thoại, đóng lần tìm đang giữ một lượt nhảy, hoặc nhảy từ quote phải vô hiệu request và deferred scroll của lượt nhảy cũ, kể cả cùng thread. Test với response đến sau khi quay về tin mới nhất.
- [x] Dùng cùng thứ tự `(ts, message_id)` với SQLite BINARY cho latest, around và sidebar preview; không dùng `localeCompare`. Test hai thứ tự socket/snapshot với timestamp trùng. Khi dựng excerpt/highlight, map vị trí sau fold về span gốc theo grapheme, không dùng offset chuỗi chuẩn hóa cắt chuỗi gốc; test dấu tiếng Việt decomposed và lowercase làm tăng độ dài.

## Nghiệm thu và hoàn tác

- `npm test -- lib/messageStore.integration.test.ts app/api/chat/search/route.test.ts app/api/chat/messages/route.test.ts app/chat/page.test.tsx` sau lượt Red tương ứng. Mở `/chat` với dữ liệu tổng hợp trên desktop và viewport điện thoại; tìm rồi nhảy tới tin cũ, thử chuyển hội thoại khi request đang đợi và nhận tin mới khi đọc lịch sử.
- Nối luồng “đến tin gốc” ở pha 2 vào cùng `around`. Hoàn tác pha 1 bằng revert lát UI/API/thao tác đọc sau khi hoàn tác pha phụ thuộc; không có migration.
