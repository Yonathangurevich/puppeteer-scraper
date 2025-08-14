const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Railway specific args - קריטי!
const RAILWAY_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process', // חובה ב-Railway
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IsolateOrigins',
  '--disable-features=site-per-process',
  '--disable-blink-features=AutomationControlled',
  '--disable-web-security',
  '--disable-domain-reliability',
  '--disable-features=AudioServiceOutOfProcess',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-features=RendererCodeIntegrity',
  '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-translate',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--ignore-certificate-errors',
  '--use-mock-keychain'
];

// Simple scraping function
async function scrapeUrl(url) {
  console.log(`\n🔍 Starting scrape for: ${url}`);
  let browser = null;
  let page = null;
  
  try {
    // Create browser with minimal resources
    console.log('📦 Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: RAILWAY_CHROME_ARGS,
      executablePath: process.env.CHROME_BIN || 
                     process.env.PUPPETEER_EXECUTABLE_PATH || 
                     '/usr/bin/chromium' ||
                     '/usr/bin/google-chrome-stable',
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: {
        width: 1280,
        height: 720
      },
      protocolTimeout: 30000
    });
    
    console.log('✅ Browser launched');
    
    // Create page
    page = await browser.newPage();
    console.log('📄 New page created');
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Enable request interception
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      // Block images, fonts, and stylesheets
      if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Navigate to URL
    console.log('🌐 Navigating to URL...');
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });
    
    console.log(`📊 Response status: ${response?.status()}`);
    
    // Check for Cloudflare
    const pageContent = await page.content();
    if (pageContent.includes('Checking your browser') || 
        pageContent.includes('Just a moment')) {
      console.log('☁️ Cloudflare detected, waiting 5 seconds...');
      await page.waitForTimeout(5000);
    }
    
    // Get final HTML
    const html = await page.content();
    console.log(`✅ Scraped ${html.length} bytes`);
    
    return {
      success: true,
      html: html,
      status: response?.status() || 200
    };
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    return {
      success: false,
      error: error.message
    };
    
  } finally {
    // Clean up
    if (page) {
      try {
        await page.close();
        console.log('📄 Page closed');
      } catch (e) {
        console.error('Error closing page:', e.message);
      }
    }
    
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Browser closed');
      } catch (e) {
        console.error('Error closing browser:', e.message);
      }
    }
  }
}

// Main scraping endpoint
app.post('/v1', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { cmd, url } = req.body;
    
    // Validate input
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    if (cmd && cmd !== 'request.get') {
      return res.status(400).json({
        status: 'error',
        message: 'Only request.get is supported'
      });
    }
    
    console.log(`\n⚡ New request at ${new Date().toISOString()}`);
    console.log(`📍 URL: ${url}`);
    
    // Perform scraping
    const result = await scrapeUrl(url);
    
    if (result.success) {
      const elapsed = Date.now() - startTime;
      console.log(`⏱️ Request completed in ${elapsed}ms`);
      
      res.json({
        status: 'ok',
        message: 'Success',
        solution: {
          url: url,
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
    console.error('❌ Request failed:', error.message);
    
    res.status(500).json({
      status: 'error',
      message: error.message,
      solution: null,
      startTimestamp: startTime,
      endTimestamp: Date.now()
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    }
  };
  
  console.log('🏥 Health check:', health);
  res.json(health);
});

// Test endpoint for simple websites
app.get('/test', async (req, res) => {
  try {
    console.log('\n🧪 Running test scrape...');
    const result = await scrapeUrl('https://example.com');
    
    if (result.success) {
      const title = result.html.match(/<title>(.*?)<\/title>/)?.[1] || 'No title';
      res.json({
        status: 'ok',
        message: 'Test successful',
        title: title,
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

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Puppeteer Scraper</title>
      <style>
        body { font-family: Arial; padding: 20px; background: #f0f0f0; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; }
        .status { color: green; font-weight: bold; }
        code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Puppeteer Scraper</h1>
        <p class="status">✅ Service is running!</p>
        <h3>Available endpoints:</h3>
        <ul>
          <li><code>GET /</code> - This page</li>
          <li><code>GET /health</code> - Health check</li>
          <li><code>GET /test</code> - Test scraping on example.com</li>
          <li><code>POST /v1</code> - Main scraping endpoint</li>
        </ul>
        <h3>Example request:</h3>
        <pre style="background: #f5f5f5; padding: 10px; border-radius: 5px;">
POST /v1
Content-Type: application/json

{
  "cmd": "request.get",
  "url": "https://example.com"
}</pre>
      </div>
    </body>
    </html>
  `);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║                                        ║
║   🚀 Puppeteer Scraper Started!        ║
║                                        ║
║   Port: ${PORT}                            ║
║   Environment: ${process.env.NODE_ENV || 'production'}         ║
║   Platform: Railway                    ║
║                                        ║
╚════════════════════════════════════════╝

Ready to accept requests...
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n📛 SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Keep alive
setInterval(() => {
  console.log(`💓 Heartbeat - ${new Date().toISOString()} - Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
}, 300000); // Every 5 minutes
