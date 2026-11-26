# TV LG Apps (LG webOS 6.0+)

Bộ ứng dụng tự phát triển tối ưu cho **LG Smart TV (webOS 6.0 / Chromium 79 + Node.js v8.12 JS Service)**, điều khiển mượt bằng LG Magic Remote & D-Pad, chạy độc lập trực tiếp trên TV không cần bật máy tính.

## Danh sách ứng dụng

### 1. `zingmp3-tv-app` + `zingmp3-tv-service` (Zing MP3 TV)
- Nghe nhạc chất lượng cao không quảng cáo trên TV: **Khám phá**, **#zingchart**, **Top 100**, **Chủ đề & Thể loại**, **Tìm kiếm**, **Yêu thích & Lịch sử**.
- Màn hình **Lời bài hát chạy đồng bộ (Synced Lyrics)** và chế độ **Full Screen Chill** tích hợp:
  - Hình nền động HD MP4 từ **GIPHY API** (tự động chuyển sang thư viện 8 hình nền tĩnh **Studio Ghibli HD/2K/4K** nếu chạm Rate Limit hoặc không có key).
  - **Đồng hồ & Lịch tháng**, **Thời tiết Biên Hòa (Open-Meteo)**, danh sách bài hát trong Album & lời bài hát mờ 50%.
  - **Music Equalizer vòng sáng cyan-trắng** co dãn theo nhịp nhạc (tối ưu nhẹ ~30 FPS cho TV).
- Để dùng GIPHY API: sao chép `zingmp3-tv-app/giphy.example.json` thành `giphy.local.json` và điền `apiKey` của bạn.

### 2. `rophim-tv-app` + `rophim-tv-service` (RoPhim TV)
- Xem phim lẻ & phim bộ Vietsub/Thuyết minh trên TV LG.
- Tích hợp **Module Chặn Quảng Cáo 3 tầng** (chặn tên miền/banner, lọc cấu hình TVC player và cắt quảng cáo chèn trong luồng HLS `.m3u8`), có bảng điều khiển thống kê & bật/tắt trực tiếp.
- Hỗ trợ chỉnh khung hình 4 chế độ (*Vừa màn / Tràn viền / Kéo đầy / Phóng to*).

### 3. `anime-tv-app` + `anime-tv-service` (Anime47 TV)
- Xem anime Vietsub/Hardsub trên TV LG với các tab **Trang chủ**, **Xem nhiều (Hôm nay / Tuần / Tháng / Năm)**, **Mùa (Tất cả / Mùa này / Mùa trước / Cũ hơn)**, **Tìm kiếm**, **Đã xem**.
- Tự động bóc header PNG giả của luồng MPEG-TS trên proxy nội bộ của TV, bấm phím **Xuống (`▼`)** để mở nhanh thanh điều khiển & chỉnh khung hình.
- Đăng nhập tài khoản Anime47 trực tiếp trong mục **Tài khoản** trên TV.

### 4. `remote-app` (LG Magic Remote Web)
- Web app điều khiển TV LG qua mạng LAN (D-Pad, bàn rê chuột, bàn phím gõ chữ, mở nhanh ứng dụng, chia sẻ màn hình WebRTC).
- Sao chép `remote-app/config.example.json` thành `remote-app/config.json` và cấu hình IP/MAC của TV.

## Đóng gói & Cài đặt lên TV LG

Yêu cầu cài `@webos-tools/cli` và bật **Developer Mode** trên TV LG:

```bash
# Ví dụ đóng gói và cài Zing MP3 TV
npx -p @webos-tools/cli ares-package -e "run-simulator*" -e "dist*" -o zingmp3-tv-app/dist zingmp3-tv-app zingmp3-tv-service
npx -p @webos-tools/cli ares-install -d lgtv zingmp3-tv-app/dist/com.giadinh.zingmp3tv_*.ipk
```
