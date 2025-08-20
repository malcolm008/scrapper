import express from 'express';
import puppeteer from 'puppeteer';
import rateLimit from 'express-rate-limit';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests, please try again later'
  })
);

const getBrowserConfig = () => {
  if (isRender) {
    // On Render, use system Firefox
    return {
      headless: true,
      product: 'firefox',
      executablePath: '/usr/bin/firefox', // System Firefox path
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      timeout: 60000
    };
  } else {
    // Local development - use auto-detection
    return {
      headless: true,
      product: 'firefox',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      timeout: 60000
    };
  }
};

// Helper functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitForDropdownUpdate = async (page, triggerSelector, triggerValue, targetSelector) => {
  try {
    await page.select(triggerSelector, triggerValue);
    
    // Wait for either loading indicator or enabled dropdown
    await Promise.race([
      page.waitForSelector('#MainContent_UpdateProgress1', { visible: true, timeout: 5000 }),
      page.waitForSelector(`${targetSelector}:not([disabled])`, { timeout: 5000 })
    ]);
    
    // If loading appeared, wait for it to disappear
    if (await page.$('#MainContent_UpdateProgress1')) {
      await page.waitForSelector('#MainContent_UpdateProgress1', { hidden: true, timeout: 15000 });
    }
    
    // Final verification
    await page.waitForSelector(`${targetSelector}:not([disabled])`, { timeout: 15000 });
    
  } catch (err) {
    console.error(`Dropdown update failed from ${triggerSelector} to ${targetSelector}:`, err);
    throw new Error(`Failed to load ${targetSelector} after selecting ${triggerValue}`);
  }
};

const getSelectOptions = async (page, selector) => {
  await page.waitForSelector(`${selector}:not([disabled])`, { timeout: 15000 });
  const options = await page.$$eval(`${selector} option`, options => 
    options.slice(1).map(o => ({
      id: o.value,
      name: o.textContent.trim()
    }))
  );
  return options;
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    environment: isProduction ? 'production' : 'development',
    browser: 'firefox'
  });
});

// Debug endpoint to check Firefox installation
app.get('/debug/firefox', async (req, res) => {
  try {
    const executablePath = puppeteer.executablePath();
    
    res.json({
      executablePath,
      product: puppeteer.product,
      defaultArgs: puppeteer.defaultArgs(),
      environment: {
        PUPPETEER_PRODUCT: process.env.PUPPETEER_PRODUCT,
        PUPPETEER_FIREFOX_SKIP_DOWNLOAD: process.env.PUPPETEER_FIREFOX_SKIP_DOWNLOAD,
        PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Main scraping endpoint
app.get('/scrape-options', async (req, res) => {
  let browser;
  try {
    const { makeId, modelId, yearId, countryId, fuelId } = req.query;
    
    console.log('Launching Firefox browser...');
    const browserConfig = getBrowserConfig();
    browser = await puppeteer.launch(browserConfig);
    
    console.log('Firefox browser launched successfully');
    const page = await browser.newPage();

    // Use Firefox user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0');
    await page.setDefaultNavigationTimeout(120000);

    console.log('Navigating to target website...');
    await page.goto('https://umvvs.tra.go.tz/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const result = {};

    // 1. Get MAKES
    if (!makeId && !modelId && !yearId && !countryId && !fuelId) {
      result.makes = await getSelectOptions(page, '#MainContent_ddlMake');
    }
    // 2. Get MODELS
    else if (makeId && !modelId) {
      await waitForDropdownUpdate(page, '#MainContent_ddlMake', makeId, '#MainContent_ddlModel');
      result.models = await getSelectOptions(page, '#MainContent_ddlModel');
    }
    // 3. Get YEARS
    else if (makeId && modelId && !yearId) {
      await waitForDropdownUpdate(page, '#MainContent_ddlMake', makeId, '#MainContent_ddlModel');
      await waitForDropdownUpdate(page, '#MainContent_ddlModel', modelId, '#MainContent_ddlYear');
      result.years = await getSelectOptions(page, '#MainContent_ddlYear');
    }
    // 4. Get COUNTRIES
    else if (makeId && modelId && yearId && !countryId) {
      await waitForDropdownUpdate(page, '#MainContent_ddlMake', makeId, '#MainContent_ddlModel');
      await waitForDropdownUpdate(page, '#MainContent_ddlModel', modelId, '#MainContent_ddlYear');
      await waitForDropdownUpdate(page, '#MainContent_ddlYear', yearId, '#MainContent_ddlCountry');
      result.countries = await getSelectOptions(page, '#MainContent_ddlCountry');
    }
    // 5. Get FUEL TYPES
    else if (makeId && modelId && yearId && countryId && !fuelId) {
      await waitForDropdownUpdate(page, '#MainContent_ddlMake', makeId, '#MainContent_ddlModel');
      await waitForDropdownUpdate(page, '#MainContent_ddlModel', modelId, '#MainContent_ddlYear');
      await waitForDropdownUpdate(page, '#MainContent_ddlYear', yearId, '#MainContent_ddlCountry');
      await waitForDropdownUpdate(page, '#MainContent_ddlCountry', countryId, '#MainContent_ddlFuel');
      result.fuels = await getSelectOptions(page, '#MainContent_ddlFuel');
    }
    // 6. Get ENGINES
    else {
      await waitForDropdownUpdate(page, '#MainContent_ddlMake', makeId, '#MainContent_ddlModel');
      await waitForDropdownUpdate(page, '#MainContent_ddlModel', modelId, '#MainContent_ddlYear');
      await waitForDropdownUpdate(page, '#MainContent_ddlYear', yearId, '#MainContent_ddlCountry');
      await waitForDropdownUpdate(page, '#MainContent_ddlCountry', countryId, '#MainContent_ddlFuel');
      await waitForDropdownUpdate(page, '#MainContent_ddlFuel', fuelId, '#MainContent_ddlEngine');
      result.engines = await getSelectOptions(page, '#MainContent_ddlEngine');
    }

    await browser.close();
    res.json(result);

  } catch (error) {
    console.error('Scraping error:', error);
    if (browser) await browser.close();
    res.status(500).json({
      error: 'Scraping failed',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  Server running in ${isProduction ? 'production' : 'development'} mode
  Port: ${PORT}
  Browser: Firefox
  `);
  
  // Log Puppeteer configuration
  console.log('Puppeteer product:', puppeteer.product);
  console.log('Puppeteer executable path:', puppeteer.executablePath());
});

// Process handlers
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  process.exit(0);
});