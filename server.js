const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Railway optimized settings
const PUPPET_OPTIONS = {
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions'
  ],
  // Let Puppeteer use its bundled Chromium
  // Remove executablePath - let Puppeteer handle it
};

async function scrapeUrl(url) {
  console.log(`Scraping: ${url}`);
  let browser = null;
  let page = null;
  
  try {
    // Launch browser
    browser = await puppeteer.launch(PUPPET_OPTIONS);
    console.log('Browser launched');
    
    // Create page
    page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    // Block resources to speed up
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Navigate
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Get HTML
    const html = await page.content();
    console.log(`Scraped ${html.length} bytes`);
    
    return html;
    
  } catch (error) {
    console.error('Scrape error:', error.message);
    throw error;
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
  }
}

// Routes
app.post('/v1', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL required'
      });
    }
    
    const html = await scrapeUrl(url);
    
    res.json({
      status: 'ok',
      solution: {
        response: html,
        status: 200,
        url: url
      }
    });
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

app.get('/test', async (req, res) => {
  try {
    const html = await scrapeUrl('https://example.com');
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    
    res.json({
      status: 'ok',
      title: title || 'No title',
      length: html.length
    });
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send('<h1>Puppeteer Scraper Running!</h1>');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
