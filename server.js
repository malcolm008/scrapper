const express = require('express');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const app = express();

// Environment configuration
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per window
    message: 'Too many requests, please try again later'
  })
);

// Puppeteer launch configuration for Render
const browserConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--single-process'
  ],
  executablePath: isProduction 
    ? process.env.PUPPETEER_EXECUTABLE_PATH 
    : undefined
};

// Helper functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForDropdownUpdate(page, triggerSelector, triggerValue, targetSelector) {
  try {
    // 1. Trigger the change
    await page.select(triggerSelector, triggerValue);
    
    // 2. Wait for either loading indicator or enabled dropdown
    await Promise.race([
      page.waitForSelector('#MainContent_UpdateProgress1', { visible: true, timeout: 2000 }),
      page.waitForSelector(`${targetSelector}:not([disabled])`, { timeout: 2000 })
    ]);
    
    // 3. If loading appeared, wait for it to disappear
    if (await page.$('#MainContent_UpdateProgress1')) {
      await page.waitForSelector('#MainContent_UpdateProgress1', { hidden: true, timeout: 10000 });
    }
    
    // 4. Final verification
    await page.waitForSelector(`${targetSelector}:not([disabled])`, { timeout: 10000 });
    
  } catch (err) {
    console.error(`Dropdown update failed from ${triggerSelector} to ${targetSelector}:`, err);
    throw new Error(`Failed to load ${targetSelector} after selecting ${triggerValue}`);
  }
}

const getSelectOptions = async (page, selector) => {
  await page.waitForSelector(`${selector}:not([disabled])`, { timeout: 10000 });
  return await page.$$eval(`${selector} option`, options => 
    options.slice(1).map(o => ({
      id: o.value,
      name: o.textContent.trim()
    }))
  );
};

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Main scraping endpoint
app.get('/scrape-options', async (req, res) => {
  let browser;
  try {
    const { makeId, modelId, yearId, countryId, fuelId } = req.query;
    browser = await puppeteer.launch(browserConfig);
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setDefaultNavigationTimeout(60000);

    await page.goto('https://umvvs.tra.go.tz/', {
      waitUntil: 'domcontentloaded'
    });

    const result = {};

    // 1. Get MAKES
    if (!makeId && !modelId && !yearId && !countryId && !fuelId) {
      result.makes = await getSelectOptions(page, '#MainContent_ddlMake');
    }
    // 2. Get MODELS
    else if (makeId && !modelId) {
        // Step 1: Select the make
        await page.select('#MainContent_ddlMake', makeId);
        
        // Step 2: Wait for either the loading indicator or the model dropdown
        try {
            await Promise.race([
            page.waitForSelector('#MainContent_UpdateProgress1', { visible: true, timeout: 2000 }),
            page.waitForSelector('#MainContent_ddlModel:not([disabled])', { timeout: 2000 })
            ]);
            
            // Step 3: If loading indicator appeared, wait for it to disappear
            if (await page.$('#MainContent_UpdateProgress1')) {
            await page.waitForSelector('#MainContent_UpdateProgress1', { hidden: true, timeout: 10000 });
            }
            
            // Step 4: Verify model dropdown is now enabled
            await page.waitForSelector('#MainContent_ddlModel:not([disabled])', { timeout: 10000 });
            result.models = await getSelectOptions(page, '#MainContent_ddlModel');
            
        } catch (err) {
            console.error('Model dropdown timeout:', err);
            throw new Error(`Model dropdown didn't load after selecting make ${makeId}. Site may be slow or the make ID is invalid.`);
        }
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
      suggestion: isProduction 
        ? 'Try again later or contact support' 
        : 'Try running with headless: false for debugging'
    });
  }
});

// Start server with Render-compatible settings
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running in ${isProduction ? 'production' : 'development'} mode on port ${PORT}`);
});

// Process handlers
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  process.exit(0);
});