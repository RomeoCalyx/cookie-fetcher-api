import { Elysia, t } from 'elysia';
import '@sinclair/typebox';
import 'puppeteer-core';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';
import { Browser } from 'puppeteer-core';
import retry from 'async-retry';

puppeteer.use(StealthPlugin());

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
  if (!options.forceRefresh) {
    const cached = getFromCache(siteUrl);
    if (cached) {
      console.log(`[CookieFetcher] Cache hit for: ${getCacheKey(siteUrl)}`);
      return cached;
    }
  }

  let browser: Browser | null = null;

  try {
    console.log(`[CookieFetcher] Launching browser for: ${siteUrl}`);
    browser = (await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: (chromium as any).headless,
    })) as unknown as Browser;

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const waitUntil = options.waitFor || 'domcontentloaded';

    try {
      console.log(`[CookieFetcher] Navigating to ${siteUrl} (waitUntil=${waitUntil})...`);
      await page.goto(siteUrl, { waitUntil, timeout: 30000 });
    } catch (navErr: any) {
      console.warn(`[CookieFetcher] Navigation warning (ignored): ${navErr.message}`);
    }

    const settleMs = options.waitMs && options.waitMs > 0 ? options.waitMs : 1000;
    console.log(`[CookieFetcher] Waiting ${settleMs}ms for cookies to settle...`);
    await new Promise(res => setTimeout(res, settleMs));

    let rawCookies: any[] = [];
    try {
      const currentUrl = page.url();
      const urlsToCheck = [...new Set([siteUrl, currentUrl])].filter(u => u && u !== 'about:blank');
      rawCookies = await page.cookies(...urlsToCheck);
    } catch {
      rawCookies = [];
    }

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
    usage: '/cookies?url=https://example.com'
  }))

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
          cookieString: entry.cookieString,
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

// Export Elysia app according to Vercel official documentation
export default app;
