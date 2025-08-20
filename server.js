import express from 'express';
import puppeteer from 'puppeteer';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Environment configuration
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const isRender = process.env.RENDER === 'true';

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

// Function to find Chrome executable
const findChromeExecutable = () => {
  if (!isRender) {
    return puppeteer.executablePath(); // Use default for local development
  }

  // Common Chrome paths on Render/Linux
  const possiblePaths = [
    '/opt/render/.cache/puppeteer/chrome/linux-*/chrome', // Render's puppeteer cache
    '/usr/bin/chromium-browser', // Common Chromium path
    '/usr/bin/google-chrome', // Common Chrome path
    '/usr/bin/chrome', // Alternative Chrome path
    process.env.CHROME_PATH // Environment variable override
  ].filter(Boolean);

  console.log('Looking for Chrome executable at paths:', possiblePaths);

  for (const pathPattern of possiblePaths) {
    try {
      // Handle wildcards in paths
      if (pathPattern.includes('*')) {
        // Use find command to locate files matching pattern
        const foundPath = execSync(`find ${pathPattern.replace('*', '')} -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
        if (foundPath) {
          console.log(`Found Chrome at: ${foundPath}`);
          return foundPath;
        }
      } else {
        // Check if specific path exists and is executable
        execSync(`ls -la ${pathPattern}`);
        console.log(`Found Chrome at: ${pathPattern}`);
        return pathPattern;
      }
    } catch (error) {
      console.log(`Chrome not found at: ${pathPattern}`);
      // Continue to next path
    }
  }

  throw new Error('Could not find Chrome executable in any known location');
};

// Puppeteer launch configuration
const getBrowserConfig = () => {
  const executablePath = findChromeExecutable();
  
  console.log(`Using Chrome executable: ${executablePath}`);
  
  return {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ],
    executablePath,
    timeout: 60000
  };
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
    isRender: isRender
  });
});

// Debug endpoint to check Chrome installation
app.get('/debug/chrome', async (req, res) => {
  try {
    // Check various Chrome paths
    const pathsToCheck = [
      '/opt/render/.cache/puppeteer/chrome/linux-*/chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/chrome'
    ];
    
    const results = {};
    
    for (const pathPattern of pathsToCheck) {
      try {
        if (pathPattern.includes('*')) {
          // Use find command for wildcard paths
          const foundPath = execSync(`find ${pathPattern.replace('*', '')} -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
          if (foundPath) {
            const version = execSync(`${foundPath} --version`).toString();
            results[pathPattern] = { exists: true, path: foundPath, version: version.trim() };
          } else {
            results[pathPattern] = { exists: false };
          }
        } else {
          const version = execSync(`${pathPattern} --version`).toString();
          results[pathPattern] = { exists: true, version: version.trim() };
        }
      } catch (e) {
        results[pathPattern] = { exists: false, error: e.message };
      }
    }
    
    res.json({
      platform: process.platform,
      arch: process.arch,
      chromePaths: results,
      puppeteerExecutablePath: puppeteer.executablePath(),
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to test basic scraping
app.get('/debug/test', async (req, res) => {
  let browser;
  try {
    const browserConfig = getBrowserConfig();
    browser = await puppeteer.launch(browserConfig);
    const page = await browser.newPage();
    
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    
    await browser.close();
    
    res.json({ 
      success: true, 
      title,
      message: 'Basic scraping test passed' 
    });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ 
      success: false, 
      error: error.message,
      suggestion: 'Check the /debug/chrome endpoint to verify Chrome installation'
    });
  }
});

// Main scraping endpoint
app.get('/scrape-options', async (req, res) => {
  let browser;
  try {
    const { makeId, modelId, yearId, countryId, fuelId } = req.query;
    
    console.log('Attempting to launch browser with configuration...');
    const browserConfig = getBrowserConfig();
    console.log('Browser config:', browserConfig);
    
    browser = await puppeteer.launch(browserConfig);
    console.log('Browser launched successfully');
    
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(120000); // 2 minutes timeout

    console.log('Navigating to target website...');
    await page.goto('https://umvvs.tra.go.tz/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    console.log('Page loaded successfully');

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
      suggestion: isProduction 
        ? 'Try again later or contact support' 
        : 'Try running with headless: false for debugging',
      timestamp: new Date().toISOString()
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  Server running in ${isProduction ? 'production' : 'development'} mode
  Port: ${PORT}
  Is Render: ${isRender}
  `);
  
  // Log Chrome path on startup
  try {
    const browserConfig = getBrowserConfig();
    console.log('Chrome executable path:', browserConfig.executablePath);
  } catch (error) {
    console.error('Error finding Chrome executable:', error.message);
  }
});

// Process handlers
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  process.exit(0);
});