const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
let browser = null;

// הגדרות מינימליות ל-Railway
const MINIMAL_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox', 
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote'
];

// אתחול פשוט
async function init() {
  try {
    console.log('Starting Puppeteer...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: MINIMAL_ARGS,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    });
    console.log('✅ Browser ready');
    return true;
  } catch (err) {
    console.error('Browser failed:', err.message);
    return false;
  }
}

// Scraping
async function scrape(url) {
  if (!browser) {
    await init();
  }
  
  const page = await browser.newPage();
  
  try {
    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 15000 
    });
    
    const html = await page.content();
    return html;
    
  } finally {
    await page.close();
  }
}

// Routes
app.post('/v1', async (req, res) => {
  try {
    const { url } = req.body;
    const html = await scrape(url);
    
    res.json({
      status: 'ok',
      solution: {
        response: html,
        status: 200,
        url: url
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: browser ? 'ready' : 'starting',
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send('Scraper running on Railway!');
});

// Start
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server on port ${PORT}`);
  await init();
});

// Cleanup
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
