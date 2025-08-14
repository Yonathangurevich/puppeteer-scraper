const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Set cache directory
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/home/pptruser/.cache/puppeteer';

console.log('Puppeteer cache dir:', process.env.PUPPETEER_CACHE_DIR);

// Browser launch options
const LAUNCH_OPTIONS = {
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  // Don't specify executablePath - let Puppeteer find it
};

async function scrapeUrl(url) {
  console.log(`Starting scrape: ${url}`);
  let browser = null;
  let page = null;
  
  try {
    // Debug: Check if Chrome exists
    const puppeteerConfig = puppeteer.configuration;
    console.log('Puppeteer config:', puppeteerConfig);
    
    // Launch browser
    console.log('Launching browser...');
    browser = await puppeteer.launch(LAUNCH_OPTIONS);
    console.log('Browser launched successfully');
    
    // Create page
    page = await browser.newPage();
    console.log('Page created');
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
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
    console.log('Navigating to URL...');
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    console.log(`Response status: ${response?.status()}`);
    
    // Get HTML
    const html = await page.content();
    console.log(`Scraped ${html.length} bytes`);
    
    return {
      success: true,
      html: html,
      status: response?.status() || 200
    };
    
  } catch (error) {
    console.error('Scrape error:', error.message);
    return {
      success: false,
      error: error.message
    };
    
  } finally {
    // Clean up
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.error('Error closing page:', e.message);
      }
    }
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e.message);
      }
    }
  }
}

// Main endpoint
app.post('/v1', async (req, res) => {
  try {
    const { cmd, url } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL is required'
      });
    }
    
    const result = await scrapeUrl(url);
    
    if (result.success) {
      res.json({
        status: 'ok',
        message: 'Success',
        solution: {
          url: url,
          status: result.status,
          response: result.html
        }
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

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    console.log('\n=== Running test ===');
    const result = await scrapeUrl('https://example.com');
    
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    cacheDir: process.env.PUPPETEER_CACHE_DIR,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Puppeteer Scraper</h1>
    <p>Status: Running</p>
    <p>Test: <a href="/test">/test</a></p>
    <p>Health: <a href="/health">/health</a></p>
  `);
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  const fs = require('fs');
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/home/pptruser/.cache/puppeteer';
  
  let contents = [];
  try {
    if (fs.existsSync(cacheDir)) {
      contents = fs.readdirSync(cacheDir, { recursive: true });
    }
  } catch (e) {
    contents = ['Error reading directory: ' + e.message];
  }
  
  res.json({
    cacheDir: cacheDir,
    exists: fs.existsSync(cacheDir),
    contents: contents,
    env: {
      PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
      HOME: process.env.HOME,
      USER: process.env.USER
    }
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 Puppeteer Scraper Started!        ║
║   Port: ${PORT}                            ║
║   Cache: ${process.env.PUPPETEER_CACHE_DIR || 'default'}
╚════════════════════════════════════════╝
  `);
});
