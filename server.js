const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const app = express();
app.use(cors());
app.use(express.json());

const SCRAPER_API_KEY = 'f8bd83ce17ec6aaf34dc1fa74daad898';

const axiosClient = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
        'Accept-Language': 'vi-VN,vi;q=0.9',
        'X-Forwarded-For': '113.190.232.115'
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
            'qdnd.vn': 'Báo Quân đội nhân dân',
            'vnexpress.net': 'VNExpress'
        };
        return sourceMap[hostname] || hostname.toUpperCase();
    } catch (e) { return 'Không rõ nguồn'; }
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

// API 1: Quét danh sách bài báo - CHỈ LẤY BÀI TRONG NGÀY & SẮP XẾP
app.post('/api/get-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    try {
        const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;
        const response = await axiosClient.get(scraperUrl);
        const dom = new JSDOM(response.data, { url });
        const document = dom.window.document;
        const potentialLinks = [];
        const seenUrls = new Set();

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        document.querySelectorAll('a').forEach(a => {
            let href = a.href;
            let text = a.textContent.trim().replace(/\s+/g, ' ');

            if (href.startsWith('http') && text.length > 20) {
                try {
                    const cleanUrl = new URL(href);
                    cleanUrl.hash = '';
                    const pathname = cleanUrl.pathname;

                    const isArticle = (pathname.endsWith('.html') || pathname.endsWith('.htm') || (cleanUrl.hostname.includes('qdnd.vn') && pathname.split('-').length >= 4));

                    if (isArticle && !seenUrls.has(cleanUrl.href)) {
                        seenUrls.add(cleanUrl.href);
                        potentialLinks.push({ title: text, url: cleanUrl.href });
                    }
                } catch (e) {}
            }
        });

        // Chỉ kiểm tra 12 bài mới nhất để tránh quá tải
        const finalLinks = [];
        const checkTasks = potentialLinks.slice(0, 12).map(async (link) => {
            try {
                const linkScraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(link.url)}`;
                const linkRes = await axiosClient.get(linkScraperUrl);
                const linkDom = new JSDOM(linkRes.data);
                const doc = linkDom.window.document;
                
                // Tìm ngày đăng bài
                const dateStr = doc.querySelector('meta[property="article:published_time"]')?.content || 
                                doc.querySelector('meta[name="pubdate"]')?.content ||
                                doc.querySelector('.date')?.textContent || 
                                doc.querySelector('.time')?.textContent;

                if (dateStr) {
                    const pubDate = new Date(dateStr);
                    if (!isNaN(pubDate.getTime())) {
                        const compareDate = new Date(pubDate);
                        compareDate.setHours(0, 0, 0, 0);

                        // Chỉ lấy bài của ngày hôm nay
                        if (compareDate.getTime() === today.getTime()) {
                            return {
                                ...link,
                                time: pubDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                                timestamp: pubDate.getTime()
                            };
                        }
                    }
                }
            } catch (err) { return null; }
        });

        const results = await Promise.all(checkTasks);
        const filteredResults = results.filter(r => r !== null && r !== undefined);
        
        // Sắp xếp mới nhất lên đầu
        filteredResults.sort((a, b) => b.timestamp - a.timestamp);
        res.json(filteredResults);

    } catch (error) {
        res.status(500).json({ error: 'Lỗi tải trang' });
    }
});

// API 2: Trích xuất nội dung
app.post('/api/extract', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

    const results = [];
    for (const targetUrl of urls) {
        try {
            const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
            const response = await axiosClient.get(scraperUrl);
            const dom = new JSDOM(response.data, { url: targetUrl });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article) throw new Error('Không phân tích được');

            const title = article.title.toUpperCase();
            const contentDom = new JSDOM(article.content);
            const images = Array.from(contentDom.window.document.querySelectorAll('img'))
                                .map(img => img.src).filter(src => src.startsWith('http'));

            let blocks = Array.from(contentDom.window.document.querySelectorAll('p, h2, h3, h4, li, blockquote'))
                .map(block => block.textContent.trim().replace(/\s+/g, ' '))
                .filter(text => text.length > 0);

            let rawAuthor = article.byline ? article.byline.trim() : '';
            if (blocks.length > 0) {
                const lastBlock = blocks[blocks.length - 1];
                if (lastBlock === lastBlock.toUpperCase() && lastBlock.length < 50) {
                    rawAuthor = lastBlock;
                    blocks.pop(); 
                }
            }

            if (blocks.length > 0) blocks[blocks.length - 1] += '/.#TQS';

            const contentText = blocks.join('\n\n');
            const finalOutput = `${title}\n\n${contentText}\n\nTác giả: ${formatAuthorName(rawAuthor)}\nNguồn: ${getSourceFromUrl(targetUrl)}`;

            results.push({ url: targetUrl, text: finalOutput, images });
        } catch (error) {
            results.push({ url: targetUrl, error: error.message });
        }
    }
    res.json(results);
});

app.get('/api/download-image', async (req, res) => {
    const imageUrl = req.query.url;
    try {
        const response = await axiosClient({ url: imageUrl, method: 'GET', responseType: 'stream' });
        const urlPath = new URL(imageUrl).pathname;
        const filename = urlPath.substring(urlPath.lastIndexOf('/') + 1) || 'image.jpg';
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);
    } catch (error) { res.status(500).send('Lỗi'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend live on port ${PORT}`));