---
phase: 2
title: "Trả lời trích dẫn"
status: todo
priority: P1
dependencies: [1]
---

# Pha 2: Trả lời trích dẫn

## Mục tiêu

Trả lời bằng văn bản vào tin văn bản có dữ liệu gốc hợp lệ trong chat 1-1 và nhóm. Chọn “Trả lời” giữ nguyên nháp và focus ô soạn; gửi lỗi giữ nháp và trích dẫn; click preview ở bong bóng nhảy tới tin gốc nếu SQLite còn tin. Không gộp reply với gửi tệp/sticker/poll, cũng không gửi văn bản thường thay cho quote khi thiếu dữ liệu.

## Tệp sở hữu

- Sửa `types/chat.ts`, `lib/socketServer.ts`, `lib/zalo.ts`, `lib/zalo.test.ts`, `lib/chatIngest.ts`, `lib/chatIngest.test.ts`, `lib/messageStore.ts`, `lib/messageStore.integration.test.ts`, `app/api/chat/send/route.ts`, `app/chat/page.tsx`, `app/chat/page.test.tsx`, `README.md`.
- Tạo `lib/socketServer.test.ts`, `app/api/chat/send/route.test.ts`. Không xóa tệp.

## Triển khai (Red → Green → Refactor)

- [ ] Viết test quote text đúng direct/group, từ chối chọn ID của hội thoại/tài khoản khác, bản ghi cũ thiếu metadata, SDK thất bại, hai thứ tự ACK và self-echo, reload/nhảy tới tin gốc và đổi hội thoại khi đang gửi.
- [ ] Trước khi phát quote metadata tối thiểu, xác thực phiên trong middleware Socket.io; kiểm Origin cùng origin app trên WebSocket và polling, tương thích cấu hình proxy đang hỗ trợ. Bind socket và publisher vào tài khoản + thế hệ phiên do server giữ; thu hồi socket khi `resetLogin`, không phát bằng SID thô sau các `await` từ API cũ. Kiểm soát đường phát message/media/group_event/reaction, bỏ log SID khi kết nối và restore, không log nội dung/SDK payload. Khi rollout thay tiến trình để các phiên đang giữ trong RAM bị vô hiệu; không ghi credential hoặc test log chứa SID. Test cookie/Origin không hợp lệ, logout/relogin và callback cũ; kiểm tra `/chat` và `/tien-ich/group-events` vẫn nhận sự kiện.
- [ ] Tách metadata dùng cho `SendMessageQuote` khỏi DTO. Khi ingest tin văn bản hỗ trợ, lưu dữ liệu tối thiểu SDK cần (`content`, `msgType`, `propertyExt`, `uidFrom`, `msgId`, `cliMsgId`, `ts`, `ttl`) bằng cột nullable thêm qua migration idempotent; test dữ liệu trước migration và reopen. Với preview incoming, đọc `data.quote.globalMsgId`, `msg` và tên hiển thị nếu xác minh được; clamp đoạn trích; giữ ID lossless, không dùng ID số đã bị làm tròn để nhảy. Với preview outgoing, lấy snapshot từ tin đích đã duyệt; cả ACK và echo đều lưu cùng link tin gốc. Không bịa metadata cho bản ghi cũ hoặc serialize raw quote fields ra API/socket; DTO chỉ có preview tối thiểu và cờ `canReply`.
- [ ] Thêm `replyToId` tùy chọn vào `/api/chat/send`; route kiểm tra kiểu hội thoại và tra cùng khóa account/type/thread/id để lấy metadata server-side rồi gọi `api.sendMessage({ msg, quote }, …)`. Không nhận preview/quote SDK từ client; trả 404 nếu không thấy mục tiêu, 409 nếu không đủ metadata hoặc đã thu hồi sau khi pha 3 vào, chỉ ghi tin đã gửi khi SDK trả message. Giữ hành vi gửi thường.
- [ ] Bổ sung đường làm giàu bản ghi khi self-echo đến sau ACK, không tăng unread lần hai. Nếu echo đến trước, ACK không ghi đè dữ liệu gốc. Không để echo/ACK làm mất URL RustFS, reaction hay preview; phát update DTO đã lưu cho phía UI khi metadata/capability thực sự thay đổi. Kiểm tra cả restore và QR có self-listen và fixture nhận đủ metadata; nếu không xác nhận được self-echo thì không đoán `cliMsgId`, chặn nghiệm thu tích hợp và ghi rõ lý do.
- [ ] `canReply` dựa vào content string gốc được SDK hỗ trợ, không dựa transcript flatten; loại `group.poll` và object `webchat`, cho phép group text thiếu `propertyExt` hợp lệ. Giải ID của quote incoming sang local key dùng global ID hoặc alias CLI được chứng minh duy nhất trong cùng scope. Không tạo canonical row từ ACK có ID không chính xác, không ghép echo theo text hay timestamp; test ACK số vượt JS safe integer, echo chỉ có CLI ID, group text không có `propertyExt` và mục tiêu không điều hướng được.
- [ ] Gắn text và quote với hội thoại + revision bản nháp. Chỉ clear revision đã gửi thành công; lỗi giữ bản nháp gốc nếu chưa sửa, không ghi đè draft mới hoặc ở thread khác. Test thành công/lỗi sau A→B→A và sau sửa draft cùng thread. Hiện cảnh báo nếu cố gửi nội dung không hỗ trợ trong lúc reply. Preview tin đến/đi dùng `around`; nếu thiếu target thì báo tin gốc không có trong lịch sử đã lưu.
- [ ] Mở menu thao tác tin qua nút Lucide có nhãn, focus được bằng bàn phím và chạm được trên mobile. Kiểm focus sau khi chọn Trả lời ở cả hai cách; không chỉ dựa vào hover hiện tại. Pha 3 dùng lại menu này.
- [ ] Route trả DTO đã commit, không phải object ACK thô. `/chat` hợp nhất DTO từ HTTP thành công theo đúng thread và message ID để tin vẫn xuất hiện nếu browser lỡ socket event; test không đếm/hiện trùng khi socket đến cả trước hoặc sau ACK. Nếu SDK đã gửi nhưng SQLite lỗi, hiển thị “Đã gửi, chưa lưu được lịch sử” và không tự gửi lại.
- [ ] Dùng migration có phiên bản, chạy trong transaction khi khởi tạo store. Kiểm thử DB thật trước nâng cấp, lần mở lại và lỗi giữa migration. Trước nghiệm thu chạy kiểm tra đọc chat trên DB đã nâng cấp; health check `/api/auth/status` hiện tại không chứng minh schema chat sẵn dùng. Không bật tính năng trên DB migration lỗi.

## Nghiệm thu và hoàn tác

Kiểm thử cục bộ đã chạy với SQLite tổng hợp, fixture SDK và trình duyệt. Cổng `ZALO_CHAT_REPLY_VERIFIED` vẫn tắt: chưa xác minh self-echo và chưa quan sát quote thật ở phía nhận. Không dùng kết quả fixture để mở cổng live.

- `npm test -- lib/socketServer.test.ts lib/zalo.test.ts lib/chatIngest.test.ts lib/messageStore.integration.test.ts app/api/chat/send/route.test.ts app/chat/page.test.tsx`. Mở `/chat` với dữ liệu tổng hợp, thử focus, gửi lỗi, click preview và đổi thread. Nghiệm thu Zalo thật chỉ khi người dùng cho phép riêng bằng tài khoản test; kiểm tra bên nhận thấy quote thật, không chỉ thấy preview web.
- Hoàn tác app giữ cột nullable; không drop cột hoặc xóa dữ liệu. Nếu đã chạy pha 3, hoàn tác pha phụ thuộc trước.
