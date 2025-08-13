const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const BlockResourcesPlugin = require('puppeteer-extra-plugin-block-resources');
const PQueue = require('p-queue').default;

// הגדרת Stealth Plugin - עוקף זיהוי בוטים
puppeteer.use(StealthPlugin());

// חסימת משאבים כבדים - משפר מהירות ב-60%!
puppeteer.use(BlockResourcesPlugin({
  blockedTypes: new Set(['image', 'stylesheet', 'font', 'media'])
}));

// Express server
const app = express();
app.use(express.json({ limit: '50mb' }));

// הגדרות גלובליות
const PORT = process.env.PORT || 8080;
const MAX_BROWSERS = 2; // 2 דפדפנים מספיקים למנוי $20
const browsers = [];
const queue = new PQueue({ concurrency: 3 }); // 3 בקשות במקביל מקסימום

// Session cache - שומר cookies
const sessionCache = new Map();
const htmlCache = new Map(); // Cache ל-HTML
const CACHE_TTL = 5 * 60 * 1000; // 5 דקות

// Browser arguments - אופטימיזציה מקסימלית
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--disable-default-apps',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--window-size=1920,1080',
  '--start-maximized',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-blink-features=AutomationControlled',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// פונקציה לאתחול ה-browser pool
async function initBrowsers() {
  console.log('🚀 Starting browser pool initialization...');
  
  for (let i = 0; i < MAX_BROWSERS; i++) {
    try {
      console.log(`  📦 Launching browser ${i + 1}/${MAX_BROWSERS}...`);
      
      const browser = await puppeteer.launch({
        headless: 'new', // Headless חדש - יותר מהיר
        args: BROWSER_ARGS,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
        defaultViewport: { width: 1920, height: 1080 }
      });
      
      browsers.push(browser);
      console.log(`  ✅ Browser ${i + 1} ready!`);
      
      // Heartbeat - בודק שהדפדפן חי כל 30 שניות
      setInterval(async () => {
        try {
          await browser.version();
        } catch (error) {
          console.log(`  ⚠️ Browser ${i + 1} died, restarting...`);
          browsers[i] = await puppeteer.launch({
            headless: 'new',
            args: BROWSER_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable'
          });
          console.log(`  ✅ Browser ${i + 1} restarted!`);
        }
      }, 30000);
      
    } catch (error) {
      console.error(`❌ Failed to launch browser ${i + 1}:`, error);
    }
  }
  
  console.log(`✅ Browser pool ready with ${browsers.length} browsers!`);
}

// פונקציה לקבלת דף חדש
async function getNewPage() {
  // בחר browser אקראי
  const browser = browsers[Math.floor(Math.random() * browsers.length)];
  
  if (!browser) {
    throw new Error('No browsers available!');
  }
  
  // צור context חדש (מבודד)
  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  
  // הגדרות הדף
  await page.setRequestInterception(true);
  
  // חסימת בקשות מיותרות
  page.on('request', (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    
    // חסום משאבים כבדים
    if (['image', 'stylesheet', 'font', 'media', 'texttrack'].includes(resourceType)) {
      request.abort();
      return;
    }
    
    // חסום tracking ו-analytics
    if (url.includes('google-analytics') || 
        url.includes('doubleclick') || 
        url.includes('facebook') ||
        url.includes('gtag') ||
        url.includes('hotjar') ||
        url.includes('clarity')) {
      request.abort();
      return;
    }
    
    request.continue();
  });
  
  // Headers נוספים
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  });
  
  return { page, context };
}

// הפונקציה הראשית - scraping מהיר
async function scrapePage(url, options = {}) {
  const startTime = Date.now();
  const { session, useCache = true, maxTimeout = 15000 } = options;
  
  // בדוק cache
  if (useCache) {
    const cacheKey = `${url}_${session || 'default'}`;
    if (htmlCache.has(cacheKey)) {
      const cached = htmlCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`⚡ Cache hit for ${url}`);
        return {
          html: cached.html,
          elapsed: 50,
          fromCache: true
        };
      }
    }
  }
  
  let page, context;
  
  try {
    // קבל דף חדש
    ({ page, context } = await getNewPage());
    
    console.log(`🔍 Scraping: ${url}`);
    
    // טען cookies אם יש session
    if (session && sessionCache.has(session)) {
      const sessionData = sessionCache.get(session);
      if (Date.now() - sessionData.timestamp < CACHE_TTL) {
        await page.setCookie(...sessionData.cookies);
        console.log(`  📦 Using cached session: ${session}`);
      }
    }
    
    // נווט לדף עם timeout
    await Promise.race([
      page.goto(url, {
        waitUntil: 'domcontentloaded', // אל תחכה לכל המשאבים!
        timeout: maxTimeout
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Navigation timeout')), maxTimeout)
      )
    ]);
    
    // בדוק אם יש Cloudflare
    const content = await page.content();
    if (content.includes('Checking your browser') || 
        content.includes('cf-browser-verification') ||
        content.includes('Just a moment')) {
      console.log('  🛡️ Cloudflare detected, waiting...');
      
      // חכה ל-Cloudflare
      await page.waitForFunction(
        () => !document.body.textContent.includes('Checking your browser'),
        { timeout: 10000 }
      );
      
      // חכה עוד קצת
      await page.waitForTimeout(2000);
    }
    
    // נסה לחכות לאלמנטים של Partsouq
    try {
      await Promise.race([
        page.waitForSelector('.parts-list', { timeout: 3000 }),
        page.waitForSelector('.group-list', { timeout: 3000 }),
        page.waitForSelector('.content', { timeout: 3000 }),
        page.waitForSelector('[data-testid="parts"]', { timeout: 3000 })
      ]);
    } catch {
      // לא נורא אם לא נמצא - נמשיך
      console.log('  ⚠️ No specific selectors found, continuing...');
    }
    
    // קח את ה-HTML הסופי
    const html = await page.content();
    
    // שמור cookies לsession
    if (session) {
      const cookies = await page.cookies();
      sessionCache.set(session, {
        cookies,
        timestamp: Date.now()
      });
    }
    
    // שמור ב-cache
    if (useCache) {
      const cacheKey = `${url}_${session || 'default'}`;
      htmlCache.set(cacheKey, {
        html,
        timestamp: Date.now()
      });
      
      // נקה cache ישן
      if (htmlCache.size > 100) {
        const oldestKey = htmlCache.keys().next().value;
        htmlCache.delete(oldestKey);
      }
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`  ✅ Scraped in ${elapsed}ms`);
    
    return {
      html,
      elapsed,
      fromCache: false
    };
    
  } catch (error) {
    console.error(`  ❌ Scraping failed: ${error.message}`);
    throw error;
    
  } finally {
    // סגור את הדף והcontext
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    if (context) {
      try {
        await context.close();
      } catch {}
    }
  }
}

// === API ENDPOINTS ===

// Endpoint ראשי - תואם FlareSolverr
app.post('/v1', async (req, res) => {
  const { cmd, url, maxTimeout = 15000, session } = req.body;
  
  // תמיכה רק ב-request.get
  if (cmd !== 'request.get') {
    return res.status(400).json({
      status: 'error',
      message: 'Only request.get is supported',
      solution: null
    });
  }
  
  try {
    // הוסף לתור
    const result = await queue.add(async () => {
      return await scrapePage(url, {
        session,
        maxTimeout,
        useCache: true
      });
    });
    
    // החזר בפורמט של FlareSolverr
    res.json({
      status: 'ok',
      message: 'Success',
      solution: {
        url: url,
        status: 200,
        cookies: [],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        headers: {},
        response: result.html
      },
      startTimestamp: Date.now() - result.elapsed,
      endTimestamp: Date.now(),
      version: '2.0.0'
    });
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null
    });
  }
});

// Endpoint בדיקת בריאות
app.get('/health', (req, res) => {
  const status = {
    status: 'healthy',
    uptime: process.uptime(),
    browsers: {
      active: browsers.length,
      target: MAX_BROWSERS
    },
    cache: {
      sessions: sessionCache.size,
      html: htmlCache.size
    },
    queue: {
      size: queue.size,
      pending: queue.pending
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    }
  };
  
  res.json(status);
});

// Endpoint לניקוי cache
app.post('/clear-cache', (req, res) => {
  sessionCache.clear();
  htmlCache.clear();
  res.json({
    status: 'ok',
    message: 'Cache cleared'
  });
});

// Endpoint בדיקה פשוטה
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Puppeteer Fast Scraper</h1>
    <p>Status: Running</p>
    <p>Browsers: ${browsers.length}/${MAX_BROWSERS}</p>
    <p>Queue: ${queue.size} pending</p>
    <p>Cache: ${htmlCache.size} pages, ${sessionCache.size} sessions</p>
    <p><a href="/health">Health Check</a></p>
  `);
});

// === SERVER STARTUP ===

async function startServer() {
  console.log('================================');
  console.log('🚀 Puppeteer Fast Scraper v2.0');
  console.log('================================');
  
  // אתחל browsers
  await initBrowsers();
  
  // התחל server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`📊 Expected performance: 5-7 seconds per request`);
    console.log(`💾 Memory limit: ~500MB for $20 plan`);
    console.log(`\n🔗 Endpoints:`);
    console.log(`   POST /v1 - Main scraping endpoint`);
    console.log(`   GET /health - Health check`);
    console.log(`   POST /clear-cache - Clear all caches`);
    console.log('\n Ready to serve requests!');
  });
}

// === ERROR HANDLING ===

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  // סגור browsers
  for (const browser of browsers) {
    try {
      await browser.close();
    } catch {}
  }
  
  process.exit(0);
});

// הפעל את השרת
startServer().catch(console.error);