# YAN Zalo

Ứng dụng web quản lý Zalo cá nhân — gửi tin nhắn, thả reaction, đính kèm file, tạo bình chọn, theo dõi thành viên nhóm và nhiều tiện ích khác, tất cả trong một giao diện duy nhất.

> **Không có backend riêng.** Toàn bộ giao tiếp với Zalo diễn ra trực tiếp từ server Next.js thông qua thư viện [**zca-js**](https://zca-js.tdung.com/vi/get-started/introduction.html) — một unofficial Zalo API client cho Node.js.

---

## ✨ Tính năng

### 💬 Chat
- Xem danh sách hội thoại (bạn bè & nhóm) theo thời gian thực qua Socket.io
  - Khi mở lại `/chat`, hội thoại đã lưu hiện trước; bạn bè và nhóm được làm mới độc lập để một danh sách chậm không chặn danh sách kia.
- Gửi tin nhắn văn bản, emoji, sticker
- **Tìm tin trong hội thoại** — mở “Lịch sử đã lưu” để tìm và nhảy tới tin cũ. Từ khóa chỉ dùng trên SQLite của ứng dụng, không gửi sang Zalo.
- **Đính kèm file** — chọn file, xem preview, gửi kèm văn bản hoặc gửi riêng
- **Ảnh và video trong chat** — xem ảnh và phát video ngay trong hội thoại; ảnh/video được lưu riêng tư trong RustFS.
- **Thả reaction** — rê chuột vào tin nhắn → thanh emoji xuất hiện → reaction hiển thị real-time
- **Chuyển tiếp tin nhắn** đến bất kỳ hội thoại nào
- **Tạo bình chọn** (cho nhóm) với nhiều lựa chọn, ẩn danh, chọn nhiều đáp án
- Tin nhắn mẫu (quick messages) — lưu sẵn, chọn 1 click
- Trên điện thoại, thanh dưới cùng chuyển giữa **Chat** và **Tiện ích**. Khi đang xem một hội thoại, nhấn **Chat** hoặc nút quay lại để về danh sách mà không mất bản nháp của hội thoại đó. Mở menu **Thao tác tin nhắn** (`…`) để thả cảm xúc mà không cần rê chuột.

### 🛠️ Tiện ích

Trên điện thoại, mở tab **Tiện ích** để xem tất cả công cụ. Trong từng công cụ, nhấn **Tất cả tiện ích** hoặc tab **Tiện ích** để quay về danh mục.

| Tiện ích | Mô tả |
|----------|-------|
| **Tra cứu người dùng** | Nhập số điện thoại → xem thông tin Zalo → chọn **Gửi lời mời kết bạn**. Để trống lời nhắn nếu muốn dùng câu chào mặc định. |
| **Nhóm chung** | Xem bạn có nhóm chung nào với một người |
| **Preview link** | Paste URL → xem thumbnail, tiêu đề, mô tả trước khi gửi |
| **Giờ hoạt động cuối** | Xem lần cuối ai đó online (kể cả người không phải bạn bè) |
| **Gợi ý kết bạn** | Xem danh sách Zalo đang gợi ý kết bạn |
| **Log sự kiện nhóm** | Theo dõi thành viên vào/ra nhóm theo thời gian thực |
| **Quét thành viên nhóm** | Xuất danh sách thành viên ra file |

### 🔐 Xác thực
- Đăng nhập bằng QR code (quét bằng Zalo trên điện thoại)
- Trình duyệt giữ phiên Zalo để có thể khôi phục sau khi khởi động lại app.

---

## 🏗️ Kiến trúc

```
┌─────────────────────────────────────────────────┐
│              Trình duyệt (React)                │
│  Next.js App Router  +  Socket.io client        │
└────────────────────┬────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────▼────────────────────────────┐
│          Next.js Server (server.ts)             │
│                                                 │
│  ┌──────────────┐    ┌──────────────────────┐  │
│  │  API Routes  │    │   Socket.io Server   │  │
│  │ /api/chat/*  │    │  (lib/socketServer)  │  │
│  │ /api/auth/*  │    └──────────┬───────────┘  │
│  │ /api/utilities/*             │               │
│  └──────┬───────┘               │               │
│         │                       │               │
│  ┌──────▼───────────────────────▼───────────┐  │
│  │              zca-js                      │  │
│  │  Unofficial Zalo API client (Node.js)   │  │
│  └──────────────────┬───────────────────────┘  │
└─────────────────────┼───────────────────────────┘
                      │ HTTPS / WebSocket
              ┌───────▼────────┐
              │  Zalo Servers  │
              └────────────────┘
```

Next.js lưu tin nhắn theo tài khoản Zalo trong SQLite (`lib/messageStore.ts`). RustFS lưu tệp ảnh và video; trình duyệt tải qua API chat đã xác thực, không truy cập trực tiếp bucket. App lưu tin nhắn nhận được khi đang kết nối và lịch sử nhóm mà Zalo trả về khi mở nhóm; đây không phải công cụ đồng bộ toàn bộ lịch sử Zalo. Nếu tệp nguồn hết hạn hoặc không đọc được, tin nhắn vẫn được lưu.

Nếu video cũ báo “Video không khả dụng”, mở lại nhóm để nhập lại tin nếu Zalo còn trả tin đó trong lịch sử và tệp nguồn vẫn tải được. Với chat cá nhân, nhờ người gửi gửi lại video vì ứng dụng không tự đồng bộ lịch sử chat cá nhân.

Thu hồi chỉ phản ánh sự kiện Zalo mà server đã nhận và xác thực; không suy ra thu hồi từ tin bị thiếu hoặc chỉ dấu chưa xác minh trong lịch sử nhóm. Khi server hoặc listener ngừng, có thể bỏ lỡ sự kiện. Tin cũ thiếu định danh nguồn đáng tin cậy không có thao tác thu hồi. Thu hồi không xóa byte đã tải, đối tượng RustFS hoặc bản sao lưu. Không phục vụ bản sao SQLite cũ như dữ liệu hiện tại nếu chưa áp lại được các dấu thu hồi phát sinh sau thời điểm sao lưu.

---

## 🚀 Cài đặt & chạy

### Chạy bằng Docker Compose

```bash
export RUSTFS_ACCESS_KEY_ID="$(openssl rand -hex 12)"
export RUSTFS_SECRET_ACCESS_KEY="$(openssl rand -hex 32)"
docker compose up -d --build --wait
```

Mở [http://localhost:3000](http://localhost:3000). Có thể đặt `YAN_ZALO_PORT` nếu cổng 3000 đang bận. Lưu hai biến RustFS vào `.env` (đã loại khỏi Git) hoặc trình quản lý bí mật để dùng lại; không tạo khóa mới mỗi lần chạy.

Compose tự tạo bucket riêng tư và không mở cổng RustFS ra máy chủ. Sao lưu cả volume `chat-data` (SQLite) và `media-data` (RustFS); không dùng `docker compose down -v` nếu cần giữ lịch sử.

### Chạy trực tiếp

Yêu cầu:
- Node.js 24+
- npm

### Các bước

```bash
# 1. Clone repo
git clone https://github.com/zack-the-worker/yan-zalo-web.git
cd yan-zalo-web

# 2. Cài dependencies
npm install

# 3. Cấu hình RustFS trong .env.local rồi chạy server
npm run dev
```

Mở [http://localhost:3000](http://localhost:3000) → đăng nhập bằng QR code Zalo.

Khi chạy trực tiếp, tạo sẵn bucket riêng tư rồi đặt `RUSTFS_ENDPOINT`, `RUSTFS_BUCKET`, `RUSTFS_ACCESS_KEY_ID` và `RUSTFS_SECRET_ACCESS_KEY`. `RUSTFS_REGION` mặc định là `us-east-1`. Đặt `CHAT_DB_PATH` nếu muốn dùng đường dẫn khác `data/chat.sqlite`.

Socket.io yêu cầu phiên Zalo đang hoạt động và cùng origin. Nếu reverse proxy thay `Host`, đặt `ZALO_APP_ORIGIN` thành origin HTTP(S) công khai của ứng dụng. Khi nâng cấp, thay tiến trình để phiên và kết nối cũ không được dùng lại; kiểm tra đọc `/api/chat/messages` bằng phiên kiểm thử sau khi mở SQLite đã nâng cấp (trạng thái đăng nhập không kiểm tra schema chat).

Gửi trích dẫn và yêu cầu thu hồi mặc định tắt. Chỉ đặt `ZALO_CHAT_REPLY_VERIFIED=true` sau khi xác nhận phía nhận thấy quote thật và self-echo giữ đủ định danh; chỉ đặt `ZALO_CHAT_RECALL_VERIFIED=true` sau khi xác nhận self-undo đúng tin trong cả chat 1-1 và nhóm bằng tài khoản kiểm thử được phép. Phản hồi “Đang chờ xác nhận” không có nghĩa là Zalo đã thu hồi tin.

---

## 🧪 Tests

```bash
npm test
```

Sử dụng **Vitest** + jsdom. Các API route, hooks và store đều có unit test.

## CI/CD

[GitHub Actions](.github/workflows/ci-cd.yml) chạy test và kiểm tra container cho pull request. Trên `main`, CI xanh mới publish image `ghcr.io/dongnv0502/yan-zalo-web` cho `linux/amd64` và `linux/arm64`, gắn tag theo commit.

CD chỉ cập nhật digest của app trong repo homelab, không đăng nhập máy chủ. Sau khi homelab có vùng lưu trữ mã hóa, RustFS được nghiệm thu với bucket và khóa riêng cho app, và Compose đã trỏ đến image theo digest, đặt secret `HOMELAB_REPO_TOKEN` (quyền `Contents: Read and write` chỉ trên repo homelab) và đặt biến `HOMELAB_DEPLOY_ENABLED=true`. Máy chủ phải có quyền pull package GHCR; không đưa khóa RustFS vào workflow.

### Deploy từ máy local lên homelab

Dùng [script deploy local](scripts/deploy-homelab.sh) để không phải chờ GitHub Actions hoặc cron. GitOps vẫn là nguồn cấu hình production; script chỉ cập nhật digest của YAN Zalo Web, không dùng `compose.yaml` dành cho môi trường local.

Cần Docker Buildx hỗ trợ `linux/amd64`, `jq`, `gh` đã đăng nhập với quyền ghi repo homelab, Docker đã đăng nhập GHCR với quyền push package, và SSH key vào homelab. Máy chủ phải có quyền pull image GHCR. Không bật đồng thời `HOMELAB_DEPLOY_ENABLED=true` nếu muốn script là đường deploy duy nhất: CD có thể ghi đè digest sau đó.

```bash
HOMELAB_SSH_TARGET='homelab@<host-tailscale>' bash scripts/deploy-homelab.sh --deploy
```

Thay `homelab@<host-tailscale>` bằng đích SSH thực tế hoặc alias SSH đã cấu hình. Script build commit `HEAD`, kể cả commit chưa push; thay đổi chưa commit không được deploy. Khi cần rollback, revert commit cập nhật digest trong repo homelab; không xóa dữ liệu. Nếu bước SSH thất bại sau khi đã cập nhật GitOps, cron vẫn có thể áp dụng digest đó.

---

## 🔧 Tech Stack

| Thành phần | Công nghệ |
|-----------|-----------|
| Framework | [Next.js 15](https://nextjs.org/) (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| Real-time | Socket.io v4 |
| Zalo API | [**zca-js**](https://zca-js.tdung.com/vi/get-started/introduction.html) |
| Icons | Lucide React |
| Testing | Vitest + jsdom |

---

## ⚠️ Lưu ý

- Đây là công cụ cá nhân, không phải ứng dụng Zalo chính thức.
- `zca-js` là thư viện **unofficial** — sử dụng theo điều khoản của Zalo và tự chịu trách nhiệm.
- Không deploy lên môi trường public nếu không hiểu rõ hàm ý bảo mật.
- **Miễn trừ trách nhiệm:** Dự án này được cung cấp "nguyên trạng" (as-is) chỉ cho mục đích học tập và cá nhân. Tác giả không chịu trách nhiệm đối với bất kỳ hậu quả nào phát sinh từ việc cài đặt, sử dụng hoặc phân phối ứng dụng này, bao gồm nhưng không giới hạn ở việc vi phạm điều khoản dịch vụ của Zalo, mất dữ liệu, hoặc các thiệt hại khác.
