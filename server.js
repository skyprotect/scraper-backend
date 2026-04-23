const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const { Readability } = require('@mozilla/readability');

const app = express();
app.use(cors());
app.use(express.json());

// Cấu hình Axios giả danh Chrome
function getStealthAxiosConfig() {
    return {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'no-cache'
        },
        timeout: 20000 
    };
}

// Hàm cốt lõi: Tự động xoay vòng Proxy miễn phí nếu bị Cloudflare chặn
async function fetchWithBypass(targetUrl, responseType = 'text') {
    const config = getStealthAxiosConfig();
    config.responseType = responseType;

    // 1. Thử kết nối trực tiếp
    try {
        const res = await axios.get(targetUrl, config);
        // Kiểm tra xem có bị Cloudflare ép giải captcha không
        if (responseType === 'text' && typeof res.data === 'string') {
            if (res.data.includes('Just a moment...') || res.data.includes('Cloudflare')) {
                throw new Error('Bị chặn bởi Cloudflare JS Challenge');
            }
        }
        return res.data;
    } catch (error) {
        console.log(`[!] Truy cập trực tiếp thất bại (${targetUrl}). Chuyển sang hệ thống Proxy dự phòng...`);

        // 2. Nếu thất bại, xoay vòng qua các Open Proxy mượn IP
        const proxies = [
            `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
            `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
            `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
        ];

        for (const proxyUrl of proxies) {
            try {
                console.log(`[>] Đang thử Proxy: ${proxyUrl}`);
                const proxyConfig = { timeout: 25000, responseType };
                const res = await axios.get(proxyUrl, proxyConfig);
                
                if (responseType === 'text' && typeof res.data === 'string') {
                    if (res.data.includes('Just a moment...') || res.data.includes('Cloudflare')) {
                        continue; // Proxy này cũng bị chặn, thử proxy tiếp theo
                    }
                }
                console.log(`[+] Proxy truy cập thành công!`);
                return res.data;
            } catch (e) {
                console.log(`[-] Proxy thất bại.`);
            }
        }
        throw new Error('Tất cả Proxy đều bị tường lửa chặn');
    }
}

// Bóc tách RSS thủ công bằng Regex (Chống mọi lỗi XML/Unexpected close tag)
function parseRssManually(xmlData) {
    const links = [];
    const seenUrls = new Set();
    
    // Tìm tất cả các block <item>...</item>
    const items = xmlData.match(/<item>[\s\S]*?<\/item>/gi) || [];

    for (const item of items) {
        let title = '';
        const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || item.match(/<title>([\s\S]*?)<\/title>/i);
        if (titleMatch) title = titleMatch[1].trim();

        let url = '';
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/i);
        if (linkMatch) {
            url = linkMatch[1].trim().replace('<![CDATA[', '').replace(']]>', '');
        }

        if (title && url) {
            try {
                const cleanUrl = new URL(url);
                cleanUrl.hash = ''; 
                url = cleanUrl.href;
            } catch(e) {}

            if (!seenUrls.has(url)) {
                seenUrls.add(url);
                links.push({ title, url });
            }
        }
        if (links.length >= 10) break; 
    }
    return links;
}

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

function formatAuthorName(nameStr) {
    if (!nameStr) return 'Không rõ';
    let cleaned = nameStr.replace(/-/g, ',');
    return cleaned.split(',').map(part => {
        return part.trim().toLowerCase().split(' ').map(word => {
            return word.charAt(0).toUpperCase() + word.slice(1);
        }).join(' ');
    }).filter(p => p.length > 0).join(', ');
}

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

// --- API 1: Lấy link bài viết (Sử dụng Bypass + Regex Parse) ---
app.post('/api/get-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    const targetRssUrl = getRssFeedUrl(url);

    try {
        const xmlData = await fetchWithBypass(targetRssUrl);
        const links = parseRssManually(xmlData);
        
        if (links.length === 0) {
            return res.status(500).json({ error: 'Không tìm thấy bài viết. Nguồn cấp RSS có thể đang trống hoặc bị lỗi cấu trúc nặng.' });
        }
        res.json(links);
    } catch (error) {
        console.error(`Lỗi get-links cho ${targetRssUrl}:`, error.message);
        res.status(500).json({ error: 'Không thể đọc dữ liệu: ' + error.message });
    }
});

// --- API 2: Trích xuất nội dung (Sử dụng Bypass) ---
app.post('/api/extract', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

    const results = [];

    for (const targetUrl of urls) {
        try {
            const htmlData = await fetchWithBypass(targetUrl);

            // Dọn dẹp HTML trước khi parse
            const cleanHtml = htmlData
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
                .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');

            const virtualConsole = new jsdom.VirtualConsole();
            const dom = new JSDOM(cleanHtml, { url: targetUrl, virtualConsole });

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

                results.push({ url: targetUrl, text: formattedText, images: images });
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

// --- API 3: Proxy Tải ảnh (Sử dụng Bypass Stream) ---
app.get('/api/download-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Thiếu URL ảnh');

    try {
        const streamData = await fetchWithBypass(imageUrl, 'stream');
        
        const urlPath = new URL(imageUrl).pathname;
        const filename = urlPath.substring(urlPath.lastIndexOf('/') + 1) || `image_${Date.now()}.jpg`;
        
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        streamData.pipe(res);
    } catch (error) {
        console.error(`Lỗi proxy tải ảnh ${imageUrl}`);
        res.status(500).send('Lỗi máy chủ khi tải ảnh');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend đang chạy tại Port: ${PORT}`));