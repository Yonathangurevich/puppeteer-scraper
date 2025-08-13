const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
let browser = null;

// Browser args מיוחדים ל-Railway
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process', // חשוב ל-Railway!
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-features=BlockInsecurePrivateNetworkRequests'
];

// פונקציה פשוטה יותר לאתחול
async function initBrowser() {
  try {
    console.log('🚀 Starting Puppeteer with Railway-optimized settings...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      executablePath: '/usr/bin/google-chrome-stable',
      ignoreDefaultArgs: ['--disable-extensions']
    });
    
    console.log('✅ Browser started successfully!');
    return true;
  } catch (error) {
    console.error('❌ Failed to start browser:', error);
    return false;
  }
}

// Scraping function פשוטה
async function scrapePage(url) {
  if (!browser) {
    throw new Error('Browser not initialized');
  }
  
  const page = await browser.newPage();
  
  try {
    // Block resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Navigate
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);
    
    const html = await page.content();
    return html;
    
  } finally {
    await page.close();
  }
}

// API endpoint
app.post('/v1', async (req, res) => {
  const { cmd, url } = req.body;
  
  if (cmd !== 'request.get') {
    return res.status(400).json({
      status: 'error',
      message: 'Only request.get supported'
    });
  }
  
  try {
    const html = await scrapePage(url);
    
    res.json({
      status: 'ok',
      message: 'Success',
      solution: {
        url: url,
        status: 200,
        response: html
      }
    });
    
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
    status: browser ? 'healthy' : 'no-browser',
    uptime: process.uptime()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('Puppeteer Scraper is running!');
});

// Start server with retry logic
async function startServer() {
  console.log('Starting server...');
  
  // נסה להתחיל browser עד 3 פעמים
  let attempts = 0;
  while (attempts < 3 && !browser) {
    attempts++;
    console.log(`Browser init attempt ${attempts}/3...`);
    await initBrowser();
    
    if (!browser) {
      console.log('Waiting 5 seconds before retry...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  // התחל server גם אם browser נכשל (לבדיקות)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server listening on port ${PORT}`);
    console.log(`🌐 Browser status: ${browser ? 'Ready' : 'Failed - will try on first request'}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start
startServer();
