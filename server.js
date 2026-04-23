const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https'); // Bổ sung thư viện xử lý chứng chỉ SSL
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const app = express();
app.use(cors());
app.use(express.json());

// Cấu hình Axios đặc biệt: Bỏ qua kiểm tra chứng chỉ SSL khắt khe để truy cập mượt mà các trang báo nhà nước
// Cấu hình Axios đặc biệt: Bổ sung Header giả mạo IP Việt Nam
const axiosClient = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'X-Forwarded-For': '113.190.232.115', // Giả mạo 1 IP của Việt Nam
        'X-Real-IP': '113.190.232.115'
    }
});

function getSourceFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        let hostname = url.hostname.replace('www.', '');
        const sourceMap = {
            'baoquangninh.vn': 'Báo Quảng Ninh',
            'tuoitre.vn': 'Báo Tuổi Trẻ',
            'baohaiphong.vn': 'Báo Hải Phòng',
            'qdnd.vn': 'Báo Quân đội nhân dân'
        };
        return sourceMap[hostname] || hostname.toUpperCase();
    } catch (e) {
        return 'Không rõ nguồn';
    }
}

function formatAuthorName(nameStr) {
    if (!nameStr) return 'Không rõ';
    let cleaned = nameStr.replace(/-/g, ',');
    return cleaned.split(',').map(part => {
        return part.trim().toLowerCase().split(' ').map(word => {
            return word.charAt(0).toUpperCase() + word.slice(1);
        }).join(' ');
    }).filter(p => p.length > 0).join(', ');
}

// API 1: Quét danh sách bài báo
app.post('/api/get-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    try {
        // Sử dụng axiosClient thay vì axios thuần
        const response = await axiosClient.get(url);

        const dom = new JSDOM(response.data, { url });
        const document = dom.window.document;
        const links = [];
        const seenUrls = new Set();

        document.querySelectorAll('a').forEach(a => {
            let href = a.href;
            let text = a.textContent.trim().replace(/\s+/g, ' ');

            if (href.startsWith('http') && text.length > 25) {
                try {
                    const cleanUrl = new URL(href);
                    cleanUrl.hash = '';
                    href = cleanUrl.href;
                    const pathname = cleanUrl.pathname;

                    // Điều kiện 1: Có đuôi .html hoặc .htm (cho VNExpress, Hải Phòng, Tuổi Trẻ...)
                    const hasHtmlExt = pathname.endsWith('.html') || pathname.endsWith('.htm');
                    
                    // Điều kiện 2: Link bài viết của QDND (Không có đuôi html nhưng chứa nhiều gạch ngang - định dạng slug)
                    const isQdndArticle = cleanUrl.hostname.includes('qdnd.vn') && pathname.split('-').length >= 4;

                    if ((hasHtmlExt || isQdndArticle) && !seenUrls.has(href)) {
                        seenUrls.add(href);
                        links.push({ title: text, url: href });
                    }
                } catch (e) {}
            }
        });

        res.json(links);
    } catch (error) {
        res.status(500).json({ error: 'Không thể tải trang này' });
    }
});

// API 2: Trích xuất nội dung
app.post('/api/extract', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

    const results = [];

    for (const targetUrl of urls) {
        try {
            // Sử dụng axiosClient thay vì axios thuần
            const response = await axiosClient.get(targetUrl);

            const dom = new JSDOM(response.data, { url: targetUrl });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article) throw new Error('Không thể phân tích nội dung');

            const title = (article.title || '').toUpperCase();

            const contentDom = new JSDOM(article.content);
            const images = Array.from(contentDom.window.document.querySelectorAll('img'))
                                .map(img => img.src)
                                .filter(src => src.startsWith('http'));

            let blocks = Array.from(contentDom.window.document.querySelectorAll('p, h2, h3, h4, li, blockquote'))
                .map(block => block.textContent.trim().replace(/\s+/g, ' '))
                .filter(text => text.length > 0);

            let rawAuthor = article.byline ? article.byline.trim() : '';

            if (blocks.length > 0) {
                const lastBlock = blocks[blocks.length - 1];
                if (lastBlock === lastBlock.toUpperCase() && lastBlock.length < 50) {
                    rawAuthor = lastBlock;
                    blocks.pop(); 
                } else if (rawAuthor && lastBlock.includes(rawAuthor)) {
                    blocks.pop(); 
                }
            }

            if (blocks.length > 0) {
                blocks[blocks.length - 1] += '/.#TQS';
            }

            const contentText = blocks.join('\n\n');
            const authorFormatted = formatAuthorName(rawAuthor);
            const source = getSourceFromUrl(targetUrl);

            const finalOutput = `${title}\n\n${contentText}\n\nTác giả: ${authorFormatted}\nNguồn: ${source}`;

            results.push({ url: targetUrl, text: finalOutput, images });
        } catch (error) {
            results.push({ url: targetUrl, error: error.message });
        }
    }

    res.json(results);
});

// API Proxy Tải ảnh
app.get('/api/download-image', async (req, res) => {
    const imageUrl = req.query.url;
    try {
        const response = await axiosClient({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream'
        });
        const urlPath = new URL(imageUrl).pathname;
        const filename = urlPath.substring(urlPath.lastIndexOf('/') + 1) || 'image.jpg';
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Lỗi tải ảnh');
    }
});

// Thay vì cố định PORT = 3000, ta lấy PORT từ môi trường của máy chủ Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend đang chạy tại Port: ${PORT}`));