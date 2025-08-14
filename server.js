const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Session cache עם TTL
const sessionCache = new Map();
const SESSION_TTL = 5 * 60 * 1000; // 5 minutes

// Browser args מאופטמים
const OPTIMIZED_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-web-security',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1920,1080',
  '--single-process', // חשוב למהירות ב-Railway
  '--disable-extensions',
  '--disable-plugins',
  '--disable-images',
  '--disable-javascript-harmony-shipping',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection'
];

// פונקציה מהירה לעקיפת Cloudflare
async function bypassCloudflare(page, url) {
  console.log('🚀 Starting fast bypass for:', url);
  const startTime = Date.now();
  
  try {
    // Navigate with shorter timeout
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    
    // Check for Cloudflare - אבל מהר יותר
    let attempts = 0;
    const maxAttempts = 5; // פחות ניסיונות
    const waitTime = 2000; // 2 שניות במקום 3
    
    while (attempts < maxAttempts) {
      const title = await page.title();
      
      if (title.includes('Just a moment')) {
        console.log(`☁️ Cloudflare detected (${attempts + 1}/${maxAttempts})`);
        
        // Wait shorter time
        await page.waitForTimeout(waitTime);
        
        // Check if challenge completed
        try {
          // נסה לחכות לאלמנט ספציפי של Partsouq
          await page.waitForSelector('body:not(:has-text("Just a moment"))', {
            timeout: 3000
          }).catch(() => {});
        } catch (e) {
          // Continue
        }
        
        attempts++;
      } else {
        // Success!
        console.log(`✅ Bypassed in ${Date.now() - startTime}ms`);
        break;
      }
    }
    
    const html = await page.content();
    const finalUrl = page.url();
    
    return {
      success: true,
      html: html,
      url: finalUrl,
      elapsed: Date.now() - startTime
    };
    
  } catch (error) {
    console.error('❌ Bypass error:', error.message);
    throw error;
  }
}

// פונקציה ראשית עם session reuse
async function scrapeWithCache(url, sessionId = null) {
  console.log(`\n📦 Session: ${sessionId || 'new'}`);
  
  // Check session cache
  if (sessionId && sessionCache.has(sessionId)) {
    const cached = sessionCache.get(sessionId);
    if (Date.now() - cached.timestamp < SESSION_TTL) {
      console.log('⚡ Using cached session');
      // Continue with cached cookies
    }
  }
  
  let browser = null;
  let page = null;
  
  try {
    // Launch browser - כל פעם מחדש אבל מהר
    browser = await puppeteer.launch({
      headless: 'new',
      args: OPTIMIZED_ARGS,
      ignoreDefaultArgs: ['--enable-automation']
    });
    
    page = await browser.newPage();
    
    // Stealth additions
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
    });
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      
      // Block images, fonts, styles
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
        req.abort();
        return;
      }
      
      // Block tracking
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
      const cached = sessionCache.get(sessionId);
      if (cached.cookies && cached.cookies.length > 0) {
        await page.setCookie(...cached.cookies);
        console.log(`🍪 Loaded ${cached.cookies.length} cookies`);
      }
    }
    
    // Bypass Cloudflare
    const result = await bypassCloudflare(page, url);
    
    // Save cookies
    if (sessionId) {
      const cookies = await page.cookies();
      sessionCache.set(sessionId, {
        cookies: cookies,
        timestamp: Date.now()
      });
      console.log(`💾 Saved ${cookies.length} cookies`);
    }
    
    return result;
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
    
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
  }
}

// Main endpoint - תואם FlareSolverr
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
    
    // Create stable session ID
    const sessionId = session || `ps_${Buffer.from(url).toString('base64').substring(0, 10)}`;
    
    // Scrape with timeout
    const scrapePromise = scrapeWithCache(url, sessionId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), maxTimeout)
    );
    
    const result = await Promise.race([scrapePromise, timeoutPromise]);
    
    if (result.success) {
      console.log(`✅ Completed in ${result.elapsed}ms`);
      
      res.json({
        status: 'ok',
        message: 'Success',
        solution: {
          url: result.url,
          status: 200,
          response: result.html,
          cookies: [],
          userAgent: 'Mozilla/5.0'
        },
        startTimestamp: startTime,
        endTimestamp: Date.now(),
        version: '2.0.0'
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    console.error('❌ Request failed:', error.message);
    
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null
    });
  }
});

// Quick test endpoint
app.get('/test', async (req, res) => {
  try {
    const result = await scrapeWithCache('https://example.com');
    
    if (result.success) {
      const title = result.html.match(/<title>(.*?)<\/title>/)?.[1];
      res.json({
        status: 'ok',
        title: title,
        elapsed: result.elapsed + 'ms'
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

// Partsouq test endpoint
app.get('/test-partsouq', async (req, res) => {
  try {
    const vin = req.query.vin || 'NLHBB51CBEZ258560';
    const url = `https://partsouq.com/en/search/all?q=${vin}`;
    
    console.log(`\n🧪 Testing Partsouq with VIN: ${vin}`);
    
    const result = await scrapeWithCache(url, `partsouq_${vin}`);
    
    if (result.success) {
      const hasProducts = result.html.includes('product') || 
                         result.html.includes('part') ||
                         result.html.includes(vin);
      
      res.json({
        status: 'ok',
        elapsed: result.elapsed + 'ms',
        length: result.html.length,
        hasProducts: hasProducts,
        url: result.url
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
    uptime: Math.round(process.uptime()) + 's',
    sessions: sessionCache.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>⚡ Fast Cloudflare Bypass</h1>
    <p>Optimized for speed!</p>
    <ul>
      <li>POST /v1 - Main endpoint</li>
      <li>GET /test-partsouq - Test Partsouq</li>
      <li>GET /health - Health check</li>
    </ul>
  `);
});

// Clear cache endpoint
app.post('/clear-cache', (req, res) => {
  const oldSize = sessionCache.size;
  sessionCache.clear();
  res.json({
    status: 'ok',
    message: `Cleared ${oldSize} sessions`
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║   ⚡ Fast Cloudflare Bypass           ║
║   Port: ${PORT}                           ║
║   Optimized for Partsouq              ║
╚═══════════════════════════════════════╝
  `);
});

// Clean old sessions periodically
setInterval(() => {
  const now = Date.now();
  let deleted = 0;
  
  for (const [key, value] of sessionCache) {
    if (now - value.timestamp > SESSION_TTL) {
      sessionCache.delete(key);
      deleted++;
    }
  }
  
  if (deleted > 0) {
    console.log(`🧹 Cleaned ${deleted} expired sessions`);
  }
}, 60000); // Every minute
