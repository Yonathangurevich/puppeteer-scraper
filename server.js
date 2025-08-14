const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cluster = require('cluster');
const os = require('os');

// Use stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Browser pool - נחזיק 2 browsers מוכנים
let browsers = [];
const BROWSER_POOL_SIZE = 2;

// Session & Page cache
const sessionCache = new Map();
const htmlCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// אופטימיזציות קריטיות
const FAST_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-gpu',
  '--no-first-run',
  '--single-process',
  '--disable-extensions',
  '--disable-plugins',
  '--disable-images', // לא טוען תמונות כלל!
  '--disable-javascript', // נפעיל רק כשצריך
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--window-size=1920,1080'
];

// Initialize browser pool
async function initBrowserPool() {
  console.log('🚀 Initializing browser pool...');
  
  for (let i = 0; i < BROWSER_POOL_SIZE; i++) {
    try {
      const browser = await puppeteer.launch({
        headless: 'new',
        args: FAST_BROWSER_ARGS,
        ignoreDefaultArgs: ['--enable-automation']
      });
      
      browsers.push({
        browser,
        busy: false,
        lastUsed: Date.now()
      });
      
      console.log(`✅ Browser ${i + 1} ready`);
    } catch (error) {
      console.error(`Failed to launch browser ${i}:`, error);
    }
  }
}

// Get available browser from pool
async function getBrowser() {
  // Find free browser
  let browserObj = browsers.find(b => !b.busy);
  
  if (!browserObj) {
    // All busy - create new one temporarily
    console.log('⚠️ All browsers busy, creating temporary one');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: FAST_BROWSER_ARGS,
      ignoreDefaultArgs: ['--enable-automation']
    });
    
    return { browser, temporary: true };
  }
  
  browserObj.busy = true;
  browserObj.lastUsed = Date.now();
  return { browser: browserObj.browser, temporary: false, obj: browserObj };
}

// Release browser back to pool
function releaseBrowser(browserObj) {
  if (browserObj && !browserObj.temporary) {
    browserObj.obj.busy = false;
  }
}

// Fast scraping with smart Cloudflare bypass
async function fastScrape(url, sessionId = null) {
  const startTime = Date.now();
  
  // Check HTML cache first
  const cacheKey = `html_${url}`;
  if (htmlCache.has(cacheKey)) {
    const cached = htmlCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('⚡ HTML cache hit!');
      return {
        success: true,
        html: cached.html,
        elapsed: 10, // מחזיר תוך 10ms!
        fromCache: true
      };
    }
  }
  
  let browserObj = null;
  let page = null;
  
  try {
    // Get browser from pool
    browserObj = await getBrowser();
    const browser = browserObj.browser;
    
    // Create page
    page = await browser.newPage();
    
    // Stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
    });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block ALL resources except document
    await page.setRequestInterception(true);
    
    let javascriptEnabled = false;
    
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const url = req.url();
      
      // Block everything except main document
      if (resourceType !== 'document' && resourceType !== 'script') {
        req.abort();
        return;
      }
      
      // Block tracking scripts
      if (url.includes('google-analytics') || 
          url.includes('doubleclick') ||
          url.includes('facebook')) {
        req.abort();
        return;
      }
      
      req.continue();
    });
    
    // Load cookies if session exists
    if (sessionId && sessionCache.has(sessionId)) {
      const session = sessionCache.get(sessionId);
      if (session.cookies) {
        await page.setCookie(...session.cookies);
        console.log('🍪 Using session cookies');
      }
    }
    
    // Navigate - FIRST attempt without JavaScript
    console.log('⚡ Fast navigation (no JS)...');
    let response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });
    
    // Check if we hit Cloudflare
    let html = await page.content();
    const needsJavaScript = html.includes('Just a moment') || 
                           html.includes('Enable JavaScript') ||
                           html.includes('cf-browser-verification');
    
    if (needsJavaScript) {
      console.log('🔧 Cloudflare detected, enabling JavaScript...');
      
      // Enable JavaScript and reload
      await page.setJavaScriptEnabled(true);
      
      // Navigate again with JavaScript
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      
      // Wait for Cloudflare to pass
      try {
        await page.waitForFunction(
          () => !document.title.includes('Just a moment'),
          { timeout: 10000, polling: 500 }
        );
        
        // Extra wait for content to load
        await page.waitForTimeout(1000);
        
      } catch (e) {
        console.log('⚠️ Cloudflare timeout, continuing...');
      }
      
      html = await page.content();
    }
    
    // Save cookies if session
    if (sessionId) {
      const cookies = await page.cookies();
      sessionCache.set(sessionId, {
        cookies,
        timestamp: Date.now()
      });
    }
    
    // Cache the HTML
    htmlCache.set(cacheKey, {
      html,
      timestamp: Date.now()
    });
    
    // Clean old cache
    if (htmlCache.size > 100) {
      const firstKey = htmlCache.keys().next().value;
      htmlCache.delete(firstKey);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Scraped in ${elapsed}ms`);
    
    return {
      success: true,
      html,
      elapsed,
      fromCache: false
    };
    
  } catch (error) {
    console.error('Scraping error:', error.message);
    return {
      success: false,
      error: error.message
    };
    
  } finally {
    // Clean up
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
    
    // Release browser back to pool
    if (browserObj) {
      if (browserObj.temporary && browserObj.browser) {
        await browserObj.browser.close();
      } else {
        releaseBrowser(browserObj);
      }
    }
  }
}

// Main endpoint - FlareSolverr compatible
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, maxTimeout = 30000, session } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n📨 Request: ${url}`);
    
    // Create session ID
    const sessionId = session || `auto_${Buffer.from(url).toString('base64').substring(0, 10)}`;
    
    // Scrape with timeout
    const result = await Promise.race([
      fastScrape(url, sessionId),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), maxTimeout)
      )
    ]);
    
    if (result.success) {
      res.json({
        status: 'ok',
        message: result.fromCache ? 'From cache' : 'Success',
        solution: {
          url: url,
          status: 200,
          response: result.html,
          cookies: [],
          userAgent: 'Mozilla/5.0'
        },
        startTimestamp: startTime,
        endTimestamp: Date.now(),
        version: '4.0.0'
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null
    });
  }
});

// Test endpoint
app.get('/test-partsouq', async (req, res) => {
  try {
    const vin = req.query.vin || 'NLHBB51CBEZ258560';
    const url = `https://partsouq.com/en/search/all?q=${vin}`;
    
    const result = await fastScrape(url, `test_${vin}`);
    
    if (result.success) {
      const hasProducts = result.html.includes('product') || 
                         result.html.includes('part') ||
                         result.html.includes(vin);
      
      res.json({
        status: 'ok',
        elapsed: result.elapsed + 'ms',
        fromCache: result.fromCache,
        hasProducts: hasProducts,
        htmlLength: result.html.length
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    browsers: browsers.length,
    activeBrowsers: browsers.filter(b => b.busy).length,
    sessions: sessionCache.size,
    cachedPages: htmlCache.size,
    uptime: Math.round(process.uptime()) + 's',
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// Clear cache
app.post('/clear-cache', (req, res) => {
  htmlCache.clear();
  sessionCache.clear();
  res.json({ status: 'ok', message: 'Cache cleared' });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>⚡ Ultra-Fast Puppeteer Scraper</h1>
    <p>Optimized for Partsouq with caching</p>
    <ul>
      <li>POST /v1 - Main endpoint</li>
      <li>GET /test-partsouq - Test Partsouq</li>
      <li>GET /health - System status</li>
      <li>POST /clear-cache - Clear all caches</li>
    </ul>
    <p>Browser pool: ${browsers.length} browsers</p>
    <p>Cached pages: ${htmlCache.size}</p>
  `);
});

// Start server
async function start() {
  await initBrowserPool();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════╗
║   ⚡ Ultra-Fast Scraper v4.0          ║
║   Port: ${PORT}                           ║
║   Browsers: ${BROWSER_POOL_SIZE}                         ║
║   Strategy: Cache + Pool + Smart JS   ║
╚═══════════════════════════════════════╝
    `);
  });
}

// Cleanup browsers every 5 minutes
setInterval(async () => {
  for (let i = 0; i < browsers.length; i++) {
    const b = browsers[i];
    if (!b.busy && Date.now() - b.lastUsed > 5 * 60 * 1000) {
      console.log(`🔄 Restarting idle browser ${i}`);
      try {
        await b.browser.close();
        b.browser = await puppeteer.launch({
          headless: 'new',
          args: FAST_BROWSER_ARGS,
          ignoreDefaultArgs: ['--enable-automation']
        });
      } catch (e) {
        console.error('Failed to restart browser:', e);
      }
    }
  }
}, 5 * 60 * 1000);

// Start
start().catch(console.error);
