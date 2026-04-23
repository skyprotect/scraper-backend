const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const Parser = require('rss-parser');

const app = express();
app.use(cors());
app.use(express.json());

const rssParser = new Parser();

// Hàm tạo IP ngẫu nhiên để xoay vòng X-Forwarded-For
function getRandomIP() {
    return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

// Cấu hình Stealth Axios
function getStealthAxiosConfig() {
    return {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Bỏ qua lỗi SSL nếu có
        headers: { 
            // Giả danh Googlebot 
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://www.google.com/', 
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1',
            'X-Forwarded-For': getRandomIP() 
        },
        timeout: 20000 // Tăng lên 20s vì đôi khi server báo chí Việt Nam phản hồi chậm
    };
}

// Map tên nguồn báo
function getSourceFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        let hostname = url.hostname.replace('www.', '');
        const sourceMap = {
            'baoquangninh.vn': 'Báo Quảng Ninh',
            'tuoitre.vn': 'Báo Tuổi Trẻ',
            'baohaiphong.vn': 'Báo Hải Phòng',
            'qdnd.vn': 'Báo Quân đội nhân dân',
            'vnexpress.net': 'VnExpress'
        };
        return sourceMap[hostname] || hostname.toUpperCase();
    } catch (e) {
        return 'Không rõ nguồn';
    }
}

// Chuẩn hóa tên tác giả
function formatAuthorName(nameStr) {
    if (!nameStr) return 'Không rõ';
    let cleaned = nameStr.replace(/-/g, ',');
    return cleaned.split(',').map(part => {
        return part.trim().toLowerCase().split(' ').map(word => {
            return word.charAt(0).toUpperCase() + word.slice(1);
        }).join(' ');
    }).filter(p => p.length > 0).join(', ');
}

// Tự động map URL trang chủ sang URL RSS tương ứng
function getRssFeedUrl(inputUrl) {
    try {
        const url = new URL(inputUrl);
        let hostname = url.hostname.replace('www.', '');
        
        const rssMap = {
            'baohaiphong.vn': 'https://baohaiphong.vn/rss/tin-moi-nhat.rss',
            'qdnd.vn': 'https://www.qdnd.vn/rss/tin-moi-nhat.rss',
            'vnexpress.net': 'https://vnexpress.net/rss/tin-moi-nhat.rss',
            'tuoitre.vn': 'https://tuoitre.vn/rss/tin-moi-nhat.rss'
        };
        
        // Nếu URL truyền vào đã là link .rss thì dùng luôn, nếu là trang chủ thì map sang rss
        return inputUrl.endsWith('.rss') ? inputUrl : (rssMap[hostname] || inputUrl);
    } catch (error) {
        return inputUrl;
    }
}

// --- API 1: Lấy link bài viết sử dụng RSS Feed ---
app.post('/api/get-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    // Tự động chuyển đổi sang RSS url
    const targetRssUrl = getRssFeedUrl(url);

    try {
        const feed = await rssParser.parseURL(targetRssUrl);
        const links = [];
        const seenUrls = new Set();

        for (const item of feed.items) {
            let href = item.link;
            try {
                const cleanUrl = new URL(href);
                cleanUrl.hash = ''; // Xóa phần # ở cuối url nếu có
                href = cleanUrl.href;
            } catch (e) {}

            if (href && !seenUrls.has(href)) {
                seenUrls.add(href);
                links.push({ title: item.title, url: href });
            }

            if (links.length >= 10) break; 
        }

        res.json(links);
    } catch (error) {
        console.error(`Lỗi get-links (RSS) cho ${targetRssUrl}:`, error.message);
        res.status(500).json({ error: 'Không thể đọc RSS Feed từ nguồn này. Máy chủ có thể đang chặn kết nối.' });
    }
});

// --- API 2: Trích xuất nội dung (Đã fix Output tương thích hoàn toàn với Frontend) ---
app.post('/api/extract', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

    const results = [];

    for (const targetUrl of urls) {
        try {
            let htmlData;
            
            try {
                const response = await axios.get(targetUrl, getStealthAxiosConfig());
                htmlData = response.data;
            } catch (error) {
                const isBlocked = error.response && (error.response.status === 403 || error.response.status === 503);
                
                if (isBlocked) {
                    console.log(`[!] Bị chặn tại ${targetUrl} (${error.response.status}). Thử Google Cache...`);
                    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(targetUrl)}`;
                    
                    const cacheResponse = await axios.get(cacheUrl, getStealthAxiosConfig());
                    htmlData = cacheResponse.data;
                } else {
                    throw error; 
                }
            }

            const dom = new JSDOM(htmlData, { url: targetUrl });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (article) {
                // 1. Trích xuất mảng hình ảnh từ HTML content đã bóc tách
                const tempDom = new JSDOM(article.content);
                const imgTags = tempDom.window.document.querySelectorAll('img');
                const images = [];
                imgTags.forEach(img => {
                    let src = img.getAttribute('src') || img.getAttribute('data-src'); // Nhiều báo dùng data-src cho lazy load
                    if (src) {
                        // Cố gắng chuyển thành URL tuyệt đối nếu nó là relative path
                        if (!src.startsWith('http')) {
                            try { src = new URL(src, targetUrl).href; } catch(e) {}
                        }
                        images.push(src);
                    }
                });

                // 2. Chuẩn hóa text cho textbox (Giống định dạng cấu trúc chuẩn /TQS)
                const sourceText = getSourceFromUrl(targetUrl);
                const authorText = formatAuthorName(article.byline);
                
                // Trả về đúng object có 'text' và 'images' để frontend gộp
                const formattedText = `Nguồn: ${sourceText}\nTiêu đề: ${article.title.trim()}\nTác giả: ${authorText}\n\nNội dung:\n${article.textContent.trim()}`;

                results.push({
                    url: targetUrl,
                    text: formattedText,
                    images: images
                });
            } else {
                results.push({ url: targetUrl, error: 'Không thể bóc tách nội dung HTML' });
            }

        } catch (error) {
            console.error(`Lỗi trích xuất ${targetUrl}:`, error.message);
            results.push({ url: targetUrl, error: 'Bị từ chối truy cập hoặc lỗi kết nối' });
        }
    }

    res.json(results);
});

// --- API 3: Proxy Tải ảnh ---
app.get('/api/download-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Thiếu URL ảnh');

    try {
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            ...getStealthAxiosConfig()
        });
        const urlPath = new URL(imageUrl).pathname;
        const filename = urlPath.substring(urlPath.lastIndexOf('/') + 1) || `image_${Date.now()}.jpg`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);
    } catch (error) {
        console.error(`Lỗi proxy tải ảnh ${imageUrl}`);
        res.status(500).send('Lỗi máy chủ khi tải ảnh');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend đang chạy tại Port: ${PORT}`));