const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const BlockResourcesPlugin = require('puppeteer-extra-plugin-block-resources');

// Use stealth plugin
puppeteer.use(StealthPlugin());

// Block unnecessary resources
puppeteer.use(BlockResourcesPlugin({
  blockedTypes: new Set(['image', 'stylesheet', 'font', 'media'])
}));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Cache for sessions
const sessionCache = new Map();

// Browser launch options - כמו FlareSolverr
const FLARESOLVERR_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-web-security',
  '--disable-features=BlockInsecurePrivateNetworkRequests',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1920,1080',
  '--start-maximized',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

async function solveCloudflare(page, url, maxWait = 30000) {
  console.log('🔍 Navigating to:', url);
  
  try {
    // Navigate to the page
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: maxWait
    });
    
    // Check for Cloudflare challenge
    let retries = 0;
    const maxRetries = 10;
    
    while (retries < maxRetries) {
      const content = await page.content();
      const title = await page.title();
      
      console.log(`⏳ Page title: ${title}`);
      
      // Check if Cloudflare challenge is present
      if (title.includes('Just a moment') || 
          content.includes('Checking your browser') ||
          content.includes('cf-browser-verification') ||
          content.includes('cf_chl_opt')) {
        
        console.log(`☁️ Cloudflare challenge detected, waiting... (${retries + 1}/${maxRetries})`);
        
        // Wait for Cloudflare to complete
        await page.waitForTimeout(3000);
        
        // Try to wait for navigation
        try {
          await page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: 5000
          });
        } catch (e) {
          // Navigation might not happen, continue checking
        }
        
        retries++;
      } else {
        console.log('✅ Page loaded successfully');
        break;
      }
    }
    
    // Final check
    const finalContent = await page.content();
    const finalUrl = page.url();
    
    console.log(`📍 Final URL: ${finalUrl}`);
    console.log(`📊 Content length: ${finalContent.length}`);
    
    return {
      success: true,
      html: finalContent,
      url: finalUrl,
      status: 200
    };
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}

async function scrapeWithSession(url, sessionId = null) {
  console.log(`\n🚀 Starting scrape with session: ${sessionId || 'new'}`);
  
  let browser = null;
  let page = null;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: FLARESOLVERR_ARGS,
      ignoreDefaultArgs: ['--enable-automation'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
    
    console.log('🌐 Browser launched');
    
    // Create page
    page = await browser.newPage();
    
    // Extra stealth measures
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      // Add chrome object
      window.chrome = {
        runtime: {}
      };
      
      // Add permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // Fix plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      // Fix languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });
    });
    
    // Set viewport
    await page.setViewport({ 
      width: 1920, 
      height: 1080 
    });
    
    // Load cookies from session if exists
    if (sessionId && sessionCache.has(sessionId)) {
      const cookies = sessionCache.get(sessionId);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`🍪 Loaded ${cookies.length} cookies from session`);
      }
    }
    
    // Solve Cloudflare and get content
    const result = await solveCloudflare(page, url);
    
    // Save cookies to session
    if (sessionId) {
      const cookies = await page.cookies();
      sessionCache.set(sessionId, cookies);
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

// Main endpoint - FlareSolverr compatible
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url, maxTimeout = 60000, session } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    console.log(`\n📨 Request: ${url}`);
    console.log(`📦 Session: ${session || 'none'}`);
    
    // Create session ID if provided
    const sessionId = session || `session_${Date.now()}`;
    
    // Scrape with timeout
    const resultPromise = scrapeWithSession(url, sessionId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), maxTimeout)
    );
    
    const result = await Promise.race([resultPromise, timeoutPromise]);
    
    if (result.success) {
      const elapsed = Date.now() - startTime;
      console.log(`✅ Success in ${elapsed}ms`);
      
      res.json({
        status: 'ok',
        message: 'Success',
        solution: {
          url: result.url,
          status: result.status,
          response: result.html,
          cookies: [],
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        startTimestamp: startTime,
        endTimestamp: Date.now(),
        version: '1.0.0'
      });
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    console.error('Request failed:', error);
    
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null,
      startTimestamp: startTime,
      endTimestamp: Date.now()
    });
  }
});

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    const result = await scrapeWithSession('https://example.com');
    
    if (result.success) {
      const title = result.html.match(/<title>(.*?)<\/title>/)?.[1];
      res.json({
        status: 'ok',
        title: title || 'No title',
        length: result.html.length
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

// Test Partsouq endpoint
app.get('/test-partsouq', async (req, res) => {
  try {
    console.log('\n🧪 Testing Partsouq...');
    const result = await scrapeWithSession(
      'https://partsouq.com/en/search/all?q=NLHBB51CBEZ258560',
      'test_session_' + Date.now()
    );
    
    if (result.success) {
      // Check if we got real content
      const hasProducts = result.html.includes('product') || 
                         result.html.includes('part') ||
                         result.html.includes('NLHBB51CBEZ258560');
      
      res.json({
        status: 'ok',
        length: result.html.length,
        hasProducts: hasProducts,
        url: result.url,
        sample: result.html.substring(0, 500)
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
    uptime: process.uptime(),
    sessions: sessionCache.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Puppeteer Scraper with Cloudflare Bypass</h1>
    <p>Endpoints:</p>
    <ul>
      <li>POST /v1 - Main scraping endpoint</li>
      <li>GET /test - Test on example.com</li>
      <li>GET /test-partsouq - Test on Partsouq</li>
      <li>GET /health - Health check</li>
    </ul>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 Cloudflare Bypass Scraper         ║
║   Port: ${PORT}                            ║
║   Mode: Stealth + Session Management   ║
╚════════════════════════════════════════╝
  `);
});

// Clean old sessions every 5 minutes
setInterval(() => {
  if (sessionCache.size > 100) {
    const toDelete = sessionCache.size - 50;
    let deleted = 0;
    for (const [key] of sessionCache) {
      if (deleted >= toDelete) break;
      sessionCache.delete(key);
      deleted++;
    }
    console.log(`🧹 Cleaned ${deleted} old sessions`);
  }
}, 5 * 60 * 1000);
