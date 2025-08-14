const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Session cache
const sessionCache = new Map();

// Browser args
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

// פונקציה חדשה - המתנה חכמה לעקיפת Cloudflare
async function waitForCloudflare(page, url, maxWait = 30000) {
  console.log('🚀 Navigating to:', url);
  const startTime = Date.now();
  
  try {
    // Navigate ONCE - כניסה אחת בלבד!
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: maxWait
    });
    
    console.log(`📊 Initial response: ${response?.status()}`);
    
    // בדוק אם יש Cloudflare
    const initialTitle = await page.title();
    console.log(`📄 Initial title: ${initialTitle}`);
    
    if (initialTitle.includes('Just a moment') || 
        initialTitle.includes('Checking your browser')) {
      
      console.log('☁️ Cloudflare detected, waiting for it to resolve...');
      
      // המתן עד שהכותרת משתנה - זה הסימן שעברנו
      try {
        await page.waitForFunction(
          () => !document.title.includes('Just a moment') && 
                !document.title.includes('Checking your browser'),
          {
            timeout: 20000, // מקסימום 20 שניות
            polling: 500 // בדוק כל חצי שנייה
          }
        );
        
        console.log('✅ Cloudflare challenge passed!');
        
        // המתן עוד קצת לטעינה מלאה
        await page.waitForTimeout(1000);
        
      } catch (timeoutError) {
        console.log('⏱️ Cloudflare timeout - trying alternative wait...');
        
        // נסה לחכות לאלמנט של Partsouq
        try {
          await page.waitForSelector('.search-results, .parts-list, .product, #app, [data-testid]', {
            timeout: 5000
          });
          console.log('✅ Found Partsouq content!');
        } catch {
          console.log('⚠️ No specific elements found, continuing anyway...');
        }
      }
    } else {
      console.log('✅ No Cloudflare detected, page loaded directly');
    }
    
    // קח את התוכן הסופי
    const html = await page.content();
    const finalUrl = page.url();
    const finalTitle = await page.title();
    
    const elapsed = Date.now() - startTime;
    console.log(`⏱️ Total time: ${elapsed}ms`);
    console.log(`📍 Final URL: ${finalUrl}`);
    console.log(`📄 Final title: ${finalTitle}`);
    
    return {
      success: true,
      html: html,
      url: finalUrl,
      title: finalTitle,
      elapsed: elapsed
    };
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Main scraping function
async function scrapeUrl(url, sessionId = null) {
  let browser = null;
  let page = null;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ['--enable-automation']
    });
    
    page = await browser.newPage();
    
    // Stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {}
      };
      
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Load cookies if available
    if (sessionId && sessionCache.has(sessionId)) {
      const session = sessionCache.get(sessionId);
      if (session.cookies && session.cookies.length > 0) {
        await page.setCookie(...session.cookies);
        console.log(`🍪 Loaded ${session.cookies.length} cookies from session`);
      }
    }
    
    // Navigate and wait for Cloudflare
    const result = await waitForCloudflare(page, url);
    
    // Save cookies for next time
    if (sessionId && result.success) {
      const cookies = await page.cookies();
      sessionCache.set(sessionId, {
        cookies: cookies,
        timestamp: Date.now()
      });
      console.log(`💾 Saved ${cookies.length} cookies to session`);
    }
    
    return result;
    
  } catch (error) {
    console.error('Scraping error:', error);
    return {
      success: false,
      error: error.message
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
    const { cmd, url, maxTimeout = 35000, session } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n📨 New request: ${url}`);
    console.log(`📦 Session: ${session || 'none'}`);
    
    // Create session ID from URL if not provided
    const sessionId = session || `auto_${Buffer.from(url).toString('base64').substring(0, 10)}`;
    
    // Scrape with timeout
    const scrapePromise = scrapeUrl(url, sessionId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), maxTimeout)
    );
    
    const result = await Promise.race([scrapePromise, timeoutPromise]);
    
    if (result.success) {
      console.log(`✅ Success in ${result.elapsed}ms`);
      
      // Check if we got real content (not Cloudflare page)
      const isCloudflare = result.title?.includes('Just a moment') || 
                          result.html?.includes('cf-browser-verification');
      
      if (isCloudflare) {
        throw new Error('Failed to bypass Cloudflare');
      }
      
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
        version: '3.0.0'
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

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    const result = await scrapeUrl('https://example.com');
    
    if (result.success) {
      res.json({
        status: 'ok',
        title: result.title,
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

// Partsouq test
app.get('/test-partsouq', async (req, res) => {
  try {
    const vin = req.query.vin || 'NLHBB51CBEZ258560';
    const url = `https://partsouq.com/en/search/all?q=${vin}`;
    
    console.log(`\n🧪 Testing Partsouq with VIN: ${vin}`);
    
    const result = await scrapeUrl(url, `partsouq_${vin}`);
    
    if (result.success) {
      // Check for real content
      const hasProducts = !result.title?.includes('Just a moment') &&
                         (result.html.includes('product') || 
                          result.html.includes('part') ||
                          result.html.includes(vin));
      
      res.json({
        status: hasProducts ? 'ok' : 'cloudflare_blocked',
        title: result.title,
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
    <h1>⚡ Smart Cloudflare Bypass</h1>
    <p>Single navigation with smart waiting</p>
    <ul>
      <li>POST /v1 - Main endpoint</li>
      <li>GET /test-partsouq - Test Partsouq</li>
      <li>GET /health - Health check</li>
    </ul>
    <p>Version: 3.0.0</p>
  `);
});

// Clear cache
app.post('/clear-cache', (req, res) => {
  const size = sessionCache.size;
  sessionCache.clear();
  res.json({
    status: 'ok',
    cleared: size
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║   ⚡ Smart Cloudflare Bypass v3       ║
║   Port: ${PORT}                           ║
║   Strategy: Single navigation         ║
║   Wait: Smart polling                 ║
╚═══════════════════════════════════════╝
  `);
});

// Clean old sessions
setInterval(() => {
  const now = Date.now();
  const TTL = 5 * 60 * 1000; // 5 minutes
  let cleaned = 0;
  
  for (const [key, value] of sessionCache) {
    if (now - value.timestamp > TTL) {
      sessionCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} old sessions`);
  }
}, 60000);
