const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https'); // Bổ sung thư viện xử lý chứng chỉ SSL
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const app = express();
app.use(cors());
app.use(express.json());

const axiosClient = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.google.com/', // Báo rất thích header này
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
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

app.post('/api/get-links', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    try {
        const domain = new URL(url).hostname.replace('www.', '');
        
        // 1. Chỉ giữ các báo thực sự chặn IP trong danh sách này
       const restrictedDomains = ['baohaiphong.vn', 'baoquangninh.vn', 'qdnd.vn'];
        const needsScraper = restrictedDomains.includes(domain);

       let htmlContent;
        if (needsScraper) {
            // Thêm render=true để ScraperAPI chạy JavaScript như trình duyệt thật
            const scraperApiUrl = `http://api.scraperapi.com?api_key=f8bd83ce17ec6aaf34dc1fa74daad898&render=true&url=${encodeURIComponent(url)}`;
            const response = await axiosClient.get(scraperApiUrl);
            htmlContent = response.data;
        } else {
            const response = await axiosClient.get(url);
            htmlContent = response.data;
        }

        const dom = new JSDOM(htmlContent, { url });
        const document = dom.window.document;
        const links = [];
        const seenUrls = new Set();

        // 2. Lấy tất cả thẻ <a> và lọc thông minh
       // Thay thế toàn bộ đoạn xử lý trong document.querySelectorAll('a').forEach(...) bằng logic này:

document.querySelectorAll('a').forEach(a => {
    let href = a.href;
    let text = a.textContent.trim().replace(/\s+/g, ' ');

    if (href.startsWith('http') && text.length > 20) {
        try {
            const cleanUrl = new URL(href);
            cleanUrl.hash = '';
            href = cleanUrl.href;
            const pathname = cleanUrl.pathname;

            // 1. Kiểm tra link thông thường (có đuôi .html hoặc .htm)
            const hasHtmlExt = pathname.endsWith('.html') || pathname.endsWith('.htm');
            
           
          // 2. Kiểm tra link đặc thù của qdnd.vn:
            // Bỏ điều kiện /tin-tuc/, chỉ cần kiểm tra đuôi kết thúc bằng "-[ID số]"
            const isQdndArticle = cleanUrl.hostname.includes('qdnd.vn') && 
                                 /-\d+$/.test(pathname);

            // Bộ lọc từ khóa rác
            const junkTitles = ['đưa nghị quyết của đảng vào cuộc sống', 'video', 'ảnh', 'longform', 'tác phẩm', 'chuyên mục'];
            const isJunk = junkTitles.some(junk => text.toLowerCase().includes(junk));

            // Chấp nhận nếu là link thường HOẶC link bài viết qdnd, và không phải là rác
            if ((hasHtmlExt || isQdndArticle) && !isJunk && !seenUrls.has(href)) {
                seenUrls.add(href);
                links.push({ title: text, url: href });
            }
        } catch (e) {}
    }
});

        // Trả về tối đa 10 bài
        res.json(links.slice(0, 10)); 

    } catch (error) {
        console.error("Lỗi get-links:", error.message);
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
            const domain = new URL(targetUrl).hostname.replace('www.', '');
            const restrictedDomains = ['baohaiphong.vn', 'baoquangninh.vn', 'qdnd.vn'];
            const needsScraper = restrictedDomains.includes(domain);

            let htmlData;
            if (needsScraper) {
                // Bắt buộc phải có &render=true để vượt tường lửa như lúc lấy link
                const scraperApiUrl = `http://api.scraperapi.com?api_key=f8bd83ce17ec6aaf34dc1fa74daad898&render=true&url=${encodeURIComponent(targetUrl)}`;
                const response = await axiosClient.get(scraperApiUrl);
                htmlData = response.data;
            } else {
                // Các trang bình thường thì dùng thẳng axiosClient
                const response = await axiosClient.get(targetUrl);
                htmlData = response.data;
            }

            const dom = new JSDOM(htmlData, { url: targetUrl });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (article) {
                results.push({
                    url: targetUrl,
                    title: article.title,
                    source: getSourceFromUrl(targetUrl),
                    author: formatAuthorName(article.byline),
                    content: article.content,
                    textContent: article.textContent
                });
            } else {
                results.push({ url: targetUrl, error: 'Không tìm thấy nội dung bài viết' });
            }

        } catch (error) {
            console.error(`Lỗi trích xuất ${targetUrl}:`, error.message);
            results.push({ url: targetUrl, error: 'Lỗi trong quá trình trích xuất' });
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