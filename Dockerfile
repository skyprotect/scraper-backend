# 1. Sử dụng image chính thức của Puppeteer (đã cài sẵn Node.js, Chrome và các thư viện Linux cần thiết)
FROM ghcr.io/puppeteer/puppeteer:latest

# 2. Chuyển sang quyền quản trị viên (root) để có thể copy và thao tác file
USER root

# 3. Tạo thư mục làm việc mặc định bên trong container
WORKDIR /app

# 4. Copy file cấu hình package.json vào trước
COPY package*.json ./

# 5. Cài đặt các thư viện (chỉ cài những package báo production để nhẹ máy)
RUN npm install

# 6. Copy toàn bộ mã nguồn của bạn (server.js, index.html...) vào container
COPY . .

# 7. Để bảo mật, cấp lại quyền sở hữu thư mục cho user mặc định (pptruser) và chuyển về user này
RUN chown -R pptruser:pptruser /app
USER pptruser

# 8. Mở cổng 3000 (hoặc cổng mà server.js của bạn đang dùng)
EXPOSE 3000

# 9. Câu lệnh cuối cùng để khởi chạy ứng dụng
CMD ["node", "server.js"]