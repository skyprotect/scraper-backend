const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const { Readability } = require('@mozilla/readability');
const Parser = require('rss-parser');

const app = express();
app.use(cors());
app.use(express.json());

const rssParser = new Parser();

// Cấu hình Stealth Axios - Giả danh Người dùng thật thay vì Googlebot
function getStealthAxiosConfig() {
    return {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        headers: { 
            // Giả danh trình duyệt Chrome trên máy tính Windows
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            // Các header Client-Hints cực kỳ quan trọng để qua mặt WAF
            'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0'
            // Xóa bỏ X-Forwarded-For vì IP ngẫu nhiên dễ bị đánh dấu spam
        },
        timeout: 20000 
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

// Tự động map URL trang chủ sang URL RSS
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
        
        return inputUrl.endsWith('.rss') ? inputUrl : (rssMap[hostname] || inputUrl);
    } catch (error) {
        return inputUrl;
    }
}

// --- API 1: Lấy link bài viết ---
app.post('/api/get-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    const targetRssUrl = getRssFeedUrl(url);

    try {
        const response = await axios.get(targetRssUrl, getStealthAxiosConfig());
        let xmlData = response.data;

        // Bắt lỗi: Nếu WAF chặn và trả về trang HTML (CAPTCHA)
        if (typeof xmlData === 'string' && xmlData.trim().toLowerCase().startsWith('<html')) {
            console.error(`[!] Bị Cloudflare/WAF chặn tại: ${targetRssUrl}`);
            return res.status(403).json({ error: 'Máy chủ báo đang bật chế độ chống Bot. Hãy thử lại sau ít phút.' });
        }

        // Fix lỗi "Attribute without value": Chuẩn hóa các attribute mồ côi trong file XML nếu có
        xmlData = xmlData.replace(/\s+(async|defer|checked|selected|disabled|readonly|multiple|ismap)([\s>])/gi, ' $1="true"$2');

        const feed = await rssParser.parseString(xmlData);
        const links = [];
        const seenUrls = new Set();

        for (const item of feed.items) {
            let href = item.link;
            try {
                const cleanUrl = new URL(href);
                cleanUrl.hash = ''; 
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
        res.status(500).json({ error: 'Không thể đọc RSS Feed. Chi tiết lỗi: ' + error.message });
    }
});

// --- API 2: Trích xuất nội dung ---
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

            // Dọn dẹp HTML trước khi parse để jsdom không bị lỗi cú pháp
            const cleanHtml = htmlData
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
                .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');

            const virtualConsole = new jsdom.VirtualConsole();
            const dom = new JSDOM(cleanHtml, { 
                url: targetUrl,
                virtualConsole 
            });

            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (article) {
                const tempDom = new JSDOM(article.content);
                const imgTags = tempDom.window.document.querySelectorAll('img');
                const images = [];
                imgTags.forEach(img => {
                    let src = img.getAttribute('src') || img.getAttribute('data-src'); 
                    if (src) {
                        if (!src.startsWith('http')) {
                            try { src = new URL(src, targetUrl).href; } catch(e) {}
                        }
                        images.push(src);
                    }
                });

                const sourceText = getSourceFromUrl(targetUrl);
                const authorText = formatAuthorName(article.byline);
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