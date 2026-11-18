---
phase: 3
title: "Thu hồi tin nhắn"
status: todo
priority: P1
dependencies: [2]
---

# Pha 3: Thu hồi tin nhắn

## Mục tiêu

Cho phép thu hồi tin của mình khi đã có đủ định danh Zalo, sau xác nhận. Đồng bộ thu hồi nhận từ Zalo cho cả tin của mình và của người khác. Giữ vị trí tin trong timeline với nhãn “Tin nhắn đã được thu hồi”. Đây không phải xóa phía tôi và không tự quyết định thời hạn thu hồi thay Zalo.

## Tệp sở hữu

- Sửa `lib/socketServer.ts`, `lib/socketServer.test.ts`, `lib/zalo.ts`, `lib/zalo.test.ts`, `lib/chatIngest.ts`, `lib/chatIngest.test.ts`, `lib/messageStore.ts`, `lib/messageStore.integration.test.ts`, `types/chat.ts`, `app/api/chat/send/route.ts`, `app/api/chat/search/route.test.ts`, `app/api/chat/forward/route.ts`, `app/api/chat/forward/route.test.ts`, `app/api/chat/reaction/route.ts`, `app/api/chat/reaction/route.test.ts`, `app/api/chat/media/[key]/route.ts`, `app/api/chat/media/[key]/route.test.ts`, `app/chat/page.tsx`, `app/chat/page.test.tsx`, `README.md`.
- Tạo `app/api/chat/recall/route.ts`, `app/api/chat/recall/route.test.ts`. Không xóa tệp.
- Sửa `app/api/chat/history/route.ts`; tạo `app/api/chat/history/route.test.ts` cho cả thứ tự marker trước/sau tin trong cùng batch.

## Triển khai (Red → Green → Refactor)

- [ ] Viết test route không phiên, tài khoản/thread/type khác, tin không phải của mình, thiếu `cliMsgId`, SDK từ chối và SDK thành công; fixture listener cho direct/group, own echo, event lặp, undo đến trước tin, media hoàn tất muộn và reload. Test UI cho lỗi giữ nguyên tin, event thắng response lịch sử trễ, preview và kết quả tìm không hiển thị nội dung đã thu hồi.
- [ ] Tách `canRecall` khỏi `canReply`: ingest định danh chính thức (`msgId`, `cliMsgId`, chủ sở hữu) cho mọi loại tin có đủ chứng cứ, kể cả media; không lấy metadata quote text làm điều kiện bắt buộc. Cột nullable cho định danh server nếu dữ liệu pha 2 không chứng minh nguồn; test ACK thiếu ID, echo bổ sung ID và echo không chứa ID hợp lệ. DTO chỉ thêm cờ `canRecall` tính theo tin của mình; không thêm trường định danh thô mới. Nếu chưa thấy cặp định danh đáng tin cậy, không hiện thao tác.
- [ ] `POST /api/chat/recall` nhận `{ threadId, threadType, messageId }`. Xác thực phiên và tra bản ghi cùng account/type/thread/id; yêu cầu chủ sở hữu đúng và định danh SDK nguồn tin cậy. Gọi `api.undo`, không `deleteMessage`. Tombstone đã commit trả 200; SDK resolve mà chưa có tombstone trả 202 “Đang chờ xác nhận”, không diễn giải `status: number`. UI kiểm tra lại đúng tin khi hết hạn; thiếu event thì báo “Chưa xác nhận thu hồi”, giữ trạng thái chưa thu hồi. Nếu Zalo không phát self-undo có thể kiểm chứng ở direct/group thì chặn bàn giao pha này, không giả thành công.
- [ ] Listener `undo` dùng `event.threadId`, loại hội thoại và ID đích trong `data.content.globalMsgId`, không dùng `data.msgId` của event. Phân biệt global ID và CLI alias; không ép số, không so khớp giá trị làm tròn. Chỉ reconcile row cũ CLI-keyed nếu alias khớp duy nhất theo account/thread/sender với bằng chứng SDK. Listener và dấu hiệu undo có dạng đã kiểm chứng trong group-history dùng chung đường ghi tombstone idempotent. Phân biệt undo history khỏi tin thường trước ingest. Trong cùng transaction loại nội dung/media/reaction/metadata, xử lý undo trước tin mà không chèn preview giả. Không để history, ACK, reaction hay media muộn tái chèn/phát lại; ACK, reads và socket dùng DTO đã lưu, đã che.
- [ ] Xác nhận fixture direct/group và history cho giá trị undo marker, trường thread và cặp ID; SDK emit không đủ chứng minh. Giữ biểu diễn chính xác cả BigNumber nếu decoder trả về; bỏ event có ID xung đột hoặc đã bị làm tròn. Undo đến trước original chỉ ghi đích đã được xác thực, không suy ra alias chưa có row.
- [ ] `history/route.ts` áp undo đã xác minh trước ingest tin thường trong cùng batch; dựng response từ các khóa canonical đã commit, không lấy ID của marker như ID tin. Không coi thiếu tin trong history là bằng chứng undo.
- [ ] Giới hạn thời gian toàn bộ request/đợi xác nhận; trong khi pending không gửi trùng. Tombstone bền thắng cả lỗi SDK đến muộn; phân biệt Zalo từ chối rõ ràng với timeout/lỗi transport hoặc parse (kết quả chưa biết). Timed-out SDK call có thể vẫn hoàn tất; không báo đã hủy và không tự retry. Test event trước lỗi SDK và promise upstream không hoàn tất.
- [ ] Sau ghi bền, gửi invalidation tối thiểu tới mọi phiên đang được xác thực cho cùng tài khoản qua scope từ pha 2, không phát room tài khoản khác. Forward và reaction kiểm nguồn theo account/type/thread/message trước khi gọi Zalo; lấy nội dung/định danh từ bản ghi chưa thu hồi, không tin text/ID giao thức do client khai. Chuyển caller `/chat` sang khóa nguồn và đóng modal mở khi thấy undo. Không hứa chặn request upstream đã gửi trước khi server nhận undo.
- [ ] UI áp tombstone cho transcript, preview danh sách, around, quote đang soạn, modal chuyển tiếp và search. Từ lần socket kết nối đầu tiên và mỗi lần reconnect: xác thực và subscribe trước resync cửa sổ đang hiển thị; invalidation trong khi resync thắng response cũ. Khi disconnect, che phần hiển thị có thể cũ tới khi resync thành công; test recall giữa snapshot và subscribe, lỗi resync và DOM không khôi phục nội dung. Chỉ bảo đảm sự kiện server thực nhận; kiểm tra tombstone đích trước ghi/serialize quote đến muộn.
- [ ] Media: recheck phiên/tài khoản và tham chiếu ngay trước khi trả stream RustFS sau `await`; đóng body nếu bị từ chối. Test full/range sau undo, recall giữa fetch và trả stream, và còn tham chiếu hợp lệ. Không thu lại bytes đã gửi, không xóa vật lý object. README nêu giới hạn ID cũ, undo chưa quan sát được khi listener offline và không bảo đảm xóa an toàn/bản sao lưu.
- [ ] `attachChatMedia` cập nhật có điều kiện theo canonical ID còn sống (không chỉ `media_key IS NULL`); resolve alias ở lúc hoàn tất và bỏ upload mới đã biết bị thu hồi. Test undo + reconcile alias trong khi RustFS upload đang đợi: không có reference, socket update hoặc quyền GET.

## Nghiệm thu và hoàn tác

Kiểm thử cục bộ đã chạy cho undo qua listener, tombstone, reconnect và media. Cổng `ZALO_CHAT_RECALL_VERIFIED` vẫn tắt: chưa xác minh self-undo thật trong chat 1-1 và nhóm. Lịch sử HTTP chỉ cách ly hàng có dấu hiệu điều khiển; chưa có bằng chứng để coi hàng đó là undo và ghi tombstone.

- `npm test -- lib/socketServer.test.ts lib/zalo.test.ts lib/chatIngest.test.ts lib/messageStore.integration.test.ts app/api/chat/recall/route.test.ts app/api/chat/send/route.test.ts app/api/chat/search/route.test.ts app/api/chat/forward/route.test.ts app/api/chat/reaction/route.test.ts app/api/chat/history/route.test.ts app/api/chat/media app/chat/page.test.tsx`. Mở `/chat` với dữ liệu tổng hợp; thử thành công/lỗi, reload và reconnect. Chạy `npm run build` cho cả stack. Thử Zalo direct/group chỉ với tài khoản test được phép.
- Hoàn tác bằng tắt UI/request nhưng giữ listener, tombstone và chính sách đọc. Giữ archive phục hồi offline tới khi áp lại được tombstone phát sinh sau backup; nếu không đủ tombstone thì không phục vụ archive cũ như dữ liệu hiện tại. Không thể đảo ngược thu hồi đã tới Zalo.
