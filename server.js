const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const BlockResourcesPlugin = require('puppeteer-extra-plugin-block-resources');

// Use stealth plugin
puppeteer.use(StealthPlugin());

// Block unnecessary resources - אבל לא scripts!
puppeteer.use(BlockResourcesPlugin({
  blockedTypes: new Set(['image', 'stylesheet', 'font', 'media'])
  // הסרנו 'script' כי זה יכול למנוע את ה-redirect
}));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Cache for sessions
const sessionCache = new Map();
const htmlCache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // הקטנתי ל-2 דקות בלבד

// Browser launch options
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-web-security',
  '--disable-gpu',
  '--no-first-run',
  '--window-size=1920,1080',
  '--single-process'
];

async function fastCloudflareBypass(page, url) {
  console.log('🚀 Starting navigation to:', url);
  const startTime = Date.now();
  
  try {
    // Navigate and wait for network to settle
    await page.goto(url, {
      waitUntil: ['domcontentloaded', 'networkidle2'], // חשוב! מחכה גם לnetwork
      timeout: 25000
    });
    
    // בדיקה אם יש Cloudflare
    const title = await page.title();
    console.log(`📄 Initial title: ${title}`);
    
    if (title.includes('Just a moment') || title.includes('Checking your browser')) {
      console.log('☁️ Cloudflare detected, waiting...');
      
      // נסה עד 5 פעמים עם המתנות משתנות
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(2000 + (i * 500)); // המתנה מתארכת
        
        const newTitle = await page.title();
        const currentUrl = page.url();
        
        console.log(`⏳ Attempt ${i + 1}/5 - Title: ${newTitle.substring(0, 30)}...`);
        console.log(`🔗 Current URL: ${currentUrl.substring(0, 80)}...`);
        
        // בדוק אם יש ssd בURL או שהtitle השתנה
        if (currentUrl.includes('ssd=') || !newTitle.includes('Just a moment')) {
          console.log(`✅ Success! Found complete URL with ssd parameter`);
          break;
        }
      }
      
      // המתנה נוספת לוודא שהכל נטען
      await page.waitForTimeout(1000);
    }
    
    // תמיד קח את הURL העדכני!
    const finalUrl = page.url();
    const html = await page.content();
    const elapsed = Date.now() - startTime;
    
    console.log(`✅ Final URL: ${finalUrl.substring(0, 100)}...`);
    console.log(`⏱️ Completed in ${elapsed}ms`);
    
    // וודא שיש ssd בURL
    if (url.includes('partsouq.com') && !finalUrl.includes('ssd=')) {
      console.log('⚠️ Warning: No ssd parameter in final URL');
    }
    
    return {
      success: true,
      html: html,
      url: finalUrl, // תמיד החזר את הURL המעודכן
      elapsed: elapsed,
      hasSSd: finalUrl.includes('ssd=')
    };
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message,
      url: url // החזר את הURL המקורי במקרה של שגיאה
    };
  }
}

async function scrapeWithCache(url, sessionId = null, useCache = true) {
  // אפשרות לבטל cache
  const cacheKey = `${url}_${sessionId || 'default'}`;
  
  // בדוק cache רק אם useCache=true ואין ssd בURL המבוקש
  if (useCache && !url.includes('ssd=') && htmlCache.has(cacheKey)) {
    const cached = htmlCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('⚡ Cache hit! But will verify URL...');
      
      // אם בcache אין URL עם ssd, נבצע scraping מחדש
      if (!cached.url || !cached.url.includes('ssd=')) {
        console.log('⚠️ Cached URL missing ssd parameter, scraping again...');
      } else {
        return {
          success: true,
          html: cached.html,
          url: cached.url, // החזר את הURL מהcache
          fromCache: true
        };
      }
    }
  }
  
  console.log(`📦 Session: ${sessionId || 'new'}`);
  console.log(`🔄 Cache: ${useCache ? 'enabled' : 'disabled'}`);
  
  let browser = null;
  let page = null;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ['--enable-automation'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
    
    page = await browser.newPage();
    
    // Enhanced stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });
    });
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Load cookies if session exists
    if (sessionId && sessionCache.has(sessionId)) {
      const cookies = sessionCache.get(sessionId);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`🍪 Using ${cookies.length} cookies from session`);
      }
    }
    
    // Intercept and monitor navigation
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const newUrl = frame.url();
        if (newUrl.includes('ssd=')) {
          console.log(`🎯 Detected navigation to URL with ssd: ${newUrl.substring(0, 80)}...`);
        }
      }
    });
    
    // Fast bypass
    const result = await fastCloudflareBypass(page, url);
    
    if (result.success) {
      // Save to cache only if we got the full URL
      if (result.url && result.url.includes('ssd=')) {
        htmlCache.set(cacheKey, {
          html: result.html,
          url: result.url, // שמור את הURL המלא
          timestamp: Date.now()
        });
        console.log('💾 Cached with full URL including ssd parameter');
      } else {
        console.log('⚠️ Not caching - URL missing ssd parameter');
      }
      
      // Save cookies
      if (sessionId) {
        const cookies = await page.cookies();
        sessionCache.set(sessionId, cookies);
        console.log(`🍪 Saved ${cookies.length} cookies to session`);
      }
      
      // Clean old cache
      if (htmlCache.size > 30) { // הקטנתי ל-30
        const firstKey = htmlCache.keys().next().value;
        htmlCache.delete(firstKey);
        console.log('🧹 Cleaned oldest cache entry');
      }
    }
    
    return result;
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    return {
      success: false,
      error: error.message,
      url: url
    };
    
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
  }
}

// Main endpoint
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, maxTimeout = 30000, session, noCache = false } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📨 New Request at ${new Date().toISOString()}`);
    console.log(`🔗 URL: ${url}`);
    console.log(`⏱️ Timeout: ${maxTimeout}ms`);
    console.log(`💾 Cache: ${noCache ? 'disabled' : 'enabled'}`);
    console.log(`${'='.repeat(60)}\n`);
    
    const sessionId = session || `auto_${Buffer.from(url).toString('base64').substring(0, 10)}`;
    
    // Scrape with timeout
    const result = await Promise.race([
      scrapeWithCache(url, sessionId, !noCache),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), maxTimeout)
      )
    ]);
    
    if (result.success) {
      const elapsed = Date.now() - startTime;
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ SUCCESS - Total time: ${elapsed}ms ${result.fromCache ? '(from cache)' : ''}`);
      console.log(`🔗 Final URL: ${result.url?.substring(0, 120) || 'N/A'}...`);
      console.log(`📄 HTML Length: ${result.html?.length || 0} bytes`);
      console.log(`🎯 Has ssd param: ${result.url?.includes('ssd=') ? 'YES ✅' : 'NO ❌'}`);
      console.log(`${'='.repeat(60)}\n`);
      
      res.json({
        status: 'ok',
        message: result.fromCache ? 'From cache' : 'Success',
        solution: {
          url: result.url || url,
          status: 200,
          response: result.html,
          cookies: [],
          userAgent: 'Mozilla/5.0'
        },
        startTimestamp: startTime,
        endTimestamp: Date.now(),
        version: '2.1.0',
        cached: result.fromCache || false,
        hasSSd: result.url?.includes('ssd=') || false
      });
    } else {
      throw new Error(result.error || 'Unknown error');
    }
    
  } catch (error) {
    console.error(`\n${'='.repeat(60)}`);
    console.error('❌ REQUEST FAILED:', error.message);
    console.error(`${'='.repeat(60)}\n`);
    
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null
    });
  }
});

// Clear cache endpoint
app.post('/clear-cache', (req, res) => {
  const sessions = sessionCache.size;
  const pages = htmlCache.size;
  sessionCache.clear();
  htmlCache.clear();
  
  console.log('🧹 Cache cleared!');
  
  res.json({
    status: 'ok',
    cleared: {
      sessions: sessions,
      pages: pages
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  
  res.json({
    status: 'healthy',
    uptime: Math.round(process.uptime()) + 's',
    sessions: sessionCache.size,
    htmlCache: htmlCache.size,
    memory: {
      used: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>⚡ Fast Puppeteer Scraper v2.1</h1>
    <p>Fixed: URL with ssd parameter caching</p>
    <ul>
      <li>POST /v1 - Main endpoint (add noCache:true to disable cache)</li>
      <li>POST /clear-cache - Clear all caches</li>
      <li>GET /health - System status</li>
    </ul>
    <p>Cache: ${htmlCache.size} pages, ${sessionCache.size} sessions</p>
    <p>Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB</p>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║   ⚡ Fast Puppeteer Scraper v2.1      ║
║   Port: ${PORT}                           ║
║   Fixed: URL caching issue            ║
╚═══════════════════════════════════════╝
  `);
});

// Clean old cache periodically
setInterval(() => {
  let cleaned = 0;
  const now = Date.now();
  
  // Clean HTML cache
  for (const [key, value] of htmlCache) {
    if (now - value.timestamp > CACHE_TTL) {
      htmlCache.delete(key);
      cleaned++;
    }
  }
  
  // Clean old sessions
  if (sessionCache.size > 50) { // הקטנתי ל-50
    const toDelete = sessionCache.size - 25;
    let deleted = 0;
    for (const [key] of sessionCache) {
      if (deleted >= toDelete) break;
      sessionCache.delete(key);
      deleted++;
    }
    cleaned += deleted;
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Periodic cleanup: ${cleaned} entries removed`);
  }
}, 60000); // Every minute
