import { Elysia, t } from 'elysia';
import '@sinclair/typebox';
import 'puppeteer-core';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';
import { Browser } from 'puppeteer-core';
import retry from 'async-retry';
import { existsSync } from 'fs';

puppeteer.use(StealthPlugin());

// ─── Smart Chromium Path ───────────────────────────────────────────────────────
// @sparticuz/chromium works on serverless (Vercel/Lambda).
// On local Windows dev, fall back to the puppeteer-bundled Chromium.
const IS_SERVERLESS = !!(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

async function getChromiumExecutable(): Promise<{ executablePath: string; headless: boolean | 'shell' }> {
  if (IS_SERVERLESS) {
    const path = await chromium.executablePath();
    console.log('[Chromium] Serverless mode — using @sparticuz/chromium:', path);
    return { executablePath: path, headless: true };
  }
  // Local dev: use puppeteer's auto-downloaded Chromium
  const { default: puppeteerVanilla } = await import('puppeteer');
  const path = await puppeteerVanilla.executablePath();
  console.log('[Chromium] Local dev mode — using puppeteer Chromium:', path);
  return { executablePath: path, headless: true };
}

// ─── Cookie Cache ─────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
  }>;
  cookieString: string;
  fetchedAt: number;
  expiresAt: number;
}

const cookieCache = new Map<string, CacheEntry>();

function getCacheKey(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getFromCache(url: string): CacheEntry | null {
  const key = getCacheKey(url);
  const entry = cookieCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cookieCache.delete(key);
    return null;
  }
  return entry;
}

function setToCache(url: string, cookies: CacheEntry['cookies']): CacheEntry {
  const key = getCacheKey(url);
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const entry: CacheEntry = {
    cookies,
    cookieString,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  cookieCache.set(key, entry);
  return entry;
}

// ─── Core Cookie Fetcher ───────────────────────────────────────────────────────
async function fetchCookiesFromSite(
  siteUrl: string,
  options: {
    waitFor?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
    waitMs?: number;
    forceRefresh?: boolean;
    maxRetries?: number;
  } = {}
): Promise<CacheEntry> {
  // Return cached entry if available
  if (!options.forceRefresh) {
    const cached = getFromCache(siteUrl);
    if (cached) {
      console.log(`[CookieFetcher] Cache hit for: ${getCacheKey(siteUrl)}`);
      return cached;
    }
  }

  let browser: Browser | null = null;

  try {
    const { executablePath, headless } = await getChromiumExecutable();

    // Local dev needs safe args; chromium.args has Lambda-specific flags (--single-process etc)
    // that crash the browser on Windows
    const launchArgs = IS_SERVERLESS
      ? chromium.args
      : [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--window-size=1280,800',
        ];

    console.log(`[CookieFetcher] Launching browser for: ${siteUrl}`);
    browser = (await puppeteer.launch({
      args: launchArgs,
      executablePath,
      headless,
    })) as unknown as Browser;

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

    const waitUntil = options.waitFor || 'domcontentloaded';

    // Navigate — site may redirect/detach the original page, that's OK
    try {
      console.log(`[CookieFetcher] Navigating to ${siteUrl} (waitUntil=${waitUntil})...`);
      await page.goto(siteUrl, { waitUntil, timeout: 30000 });
    } catch (navErr: any) {
      const msg: string = navErr?.message || '';
      const isRedirect =
        msg.includes('detached') ||
        msg.includes('Detached') ||
        msg.includes('Session closed') ||
        msg.includes('net::ERR_ABORTED');
      if (!isRedirect) throw navErr;
      console.warn(`[CookieFetcher] Redirect detected (ignored): ${msg.split('\n')[0]}`);
    }

    // Wait for JS cookies to set
    const settleMs = options.waitMs && options.waitMs > 0 ? options.waitMs : 1000;
    console.log(`[CookieFetcher] Waiting ${settleMs}ms for cookies to settle...`);
    await new Promise(res => setTimeout(res, settleMs));

    // Get cookies for BOTH the original URL and current page URL (handles redirects)
    // page.cookies(...urls) returns cookies for all specified URLs
    let rawCookies: any[] = [];
    try {
      const currentUrl = page.url();
      const urlsToCheck = [...new Set([siteUrl, currentUrl])].filter(u => u && u !== 'about:blank');
      console.log(`[CookieFetcher] Fetching cookies for: ${urlsToCheck.join(', ')}`);
      rawCookies = await page.cookies(...urlsToCheck);
    } catch {
      // Page session closed (redirect closed page) — use CDP
      try {
        const client = await (page as any).createCDPSession();
        const { cookies: allCookies } = await client.send('Network.getAllCookies') as any;
        const domain = getCacheKey(siteUrl);
        rawCookies = (allCookies as any[]).filter((c: any) =>
          c.domain === domain ||
          c.domain === `.${domain}` ||
          c.domain.endsWith(`.${domain}`)
        );
      } catch {
        rawCookies = [];
      }
    }

    // Deduplicate by name+domain (in case same cookie comes from multiple URL queries)
    const seen = new Set<string>();
    const cookies = rawCookies
      .filter((c: any) => {
        const key = `${c.name}||${c.domain}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as string | undefined,
      }));

    console.log(`[CookieFetcher] Got ${cookies.length} cookies from ${getCacheKey(siteUrl)}`);
    return setToCache(siteUrl, cookies);


  } finally {
    if (browser) {
      await browser.close();
      console.log('[CookieFetcher] Browser closed');
    }
  }
}

// ─── Elysia App ───────────────────────────────────────────────────────────────
const app = new Elysia()

  .get('/', () => ({
    status: 'Cookie Fetcher API running 🍪',
    endpoints: {
      'GET /cookies?url=': 'Fetch cookies from any site',
      'GET /cookies/cache': 'View cached domains',
      'DELETE /cookies/cache': 'Clear cache',
    },
    queryParams: {
      url: '(required) Site URL',
      refresh: '(optional) true = force re-fetch',
      wait: '(optional) Extra ms wait after page load, e.g. 3000',
      waitFor: '(optional) load | domcontentloaded | networkidle0 | networkidle2',
      retries: '(optional) Retry count on navigation failure (default: 2)',
    },
  }))

  // ── Fetch cookies from any URL ──
  .get(
    '/cookies',
    async ({ query, set }) => {
      const { url, refresh, wait, waitFor, retries } = query;

      if (!url) {
        set.status = 400;
        return { success: false, error: 'Missing "url" query parameter.' };
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
      } catch {
        set.status = 400;
        return { success: false, error: `Invalid URL: "${url}"` };
      }

      try {
        const forceRefresh = refresh === 'true' || refresh === '1';
        const entry = await fetchCookiesFromSite(url, {
          forceRefresh,
          waitMs: wait ? parseInt(wait) : 0,
          waitFor: (waitFor as any) || 'domcontentloaded',
          maxRetries: retries ? parseInt(retries) : 2,
        });

        const fromCache = !forceRefresh && (entry.fetchedAt < Date.now() - 500);

        return {
          success: true,
          domain: parsedUrl.hostname,
          url,
          fromCache,
          fetchedAt: new Date(entry.fetchedAt).toISOString(),
          expiresAt: new Date(entry.expiresAt).toISOString(),
          cacheTTLMinutes: CACHE_TTL_MS / 60000,
          cookieCount: entry.cookies.length,
          cookieString: entry.cookieString,   // ← ready to use as DEFAULT_COOKIES
          cookies: entry.cookies,
        };
      } catch (e: any) {
        set.status = 500;
        return { success: false, url, error: e.message || 'Failed to fetch cookies' };
      }
    },
    {
      query: t.Object({
        url: t.String(),
        refresh: t.Optional(t.String()),
        wait: t.Optional(t.String()),
        waitFor: t.Optional(t.String()),
        retries: t.Optional(t.String()),
      }),
    }
  )

  // ── View cache ──
  .get('/cookies/cache', () => {
    const entries: any[] = [];
    for (const [domain, entry] of cookieCache.entries()) {
      const ttlMs = Math.max(0, entry.expiresAt - Date.now());
      entries.push({
        domain,
        cookieCount: entry.cookies.length,
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
        ttlRemainingSeconds: Math.floor(ttlMs / 1000),
        cookieString: entry.cookieString,
      });
    }
    return {
      success: true,
      cachedDomains: cookieCache.size,
      cacheTTLMinutes: CACHE_TTL_MS / 60000,
      entries,
    };
  })

  // ── Clear cache ──
  .delete(
    '/cookies/cache',
    ({ query }) => {
      if (query.url) {
        const key = getCacheKey(query.url);
        const deleted = cookieCache.delete(key);
        return { success: true, deleted, domain: key };
      }
      const count = cookieCache.size;
      cookieCache.clear();
      return { success: true, message: `Cleared ${count} cached domain(s)` };
    },
    {
      query: t.Object({
        url: t.Optional(t.String()),
      }),
    }
  );

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3001;
  app.listen(PORT, () => {
    console.log(`\n${'='.repeat(52)}`);
    console.log(`🍪  Cookie Fetcher API running on port ${PORT}`);
    console.log(`📡  http://localhost:${PORT}/cookies?url=https://snapwc.com`);
    console.log(`📦  Cache: http://localhost:${PORT}/cookies/cache`);
    console.log(`${'='.repeat(52)}\n`);
  });
}

// Vercel Serverless Function adapter for Node.js runtime
export default async function handler(req: any, res: any) {
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const fullUrl = `${protocol}://${host}${req.url || '/'}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        if (Array.isArray(value)) {
          value.forEach(v => headers.append(key, v));
        } else {
          headers.set(key, value as string);
        }
      }
    }

    const method = req.method || 'GET';
    let body: any = undefined;
    if (method !== 'GET' && method !== 'HEAD' && req.body) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const webRequest = new Request(fullUrl, { method, headers, body });
    const response = await app.handle(webRequest);

    res.statusCode = response.status;
    response.headers.forEach((val: string, key: string) => {
      res.setHeader(key, val);
    });

    const arrayBuffer = await response.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: false, error: err.message || 'Internal Server Error' }));
  }
}


