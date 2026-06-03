import { chromium } from 'playwright';

const username = (process.env.X_USERNAME || 'sphere_homotopy').replace(/^@/, '').trim();
const webappUrl = process.env.WEBAPP_URL;
const token = process.env.INGEST_TOKEN;
const xAuthToken = process.env.X_AUTH_TOKEN;
const xCt0 = process.env.X_CT0;

if (!webappUrl) {
  throw new Error('WEBAPP_URL env var is required');
}

if (!token) {
  throw new Error('INGEST_TOKEN env var is required');
}

function parseCompactNumber(text) {
  const clean = String(text || '')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const match = clean.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = (match[2] || '').toUpperCase();
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;

  return Math.round(value * multiplier);
}

async function addXAuthCookies(context) {
  if (!xAuthToken || !xCt0) {
    console.log('X login cookies are not set; running verified collection as a logged-out public visitor.');
    return false;
  }

  const domains = ['.x.com', 'x.com', '.twitter.com', 'twitter.com'];
  const cookies = domains.flatMap((domain) => [
    {
      name: 'auth_token',
      value: xAuthToken,
      domain,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    },
    {
      name: 'ct0',
      value: xCt0,
      domain,
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    }
  ]);

  await context.addCookies(cookies);
  console.log('X login cookies were loaded from GitHub Secrets.');
  return true;
}

function normalizeHandleFromHref(href) {
  try {
    const url = new URL(href, 'https://x.com');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length !== 1) return null;

    const handle = parts[0];
    const reserved = new Set([
      'home',
      'explore',
      'notifications',
      'messages',
      'i',
      'settings',
      'login',
      'signup',
      'compose',
      'search'
    ]);

    if (reserved.has(handle.toLowerCase())) return null;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;

    return handle.toLowerCase();
  } catch {
    return null;
  }
}

function compactText(text, maxLength = 180) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

async function extractMetricFromSelectors(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const text = await locator.innerText({ timeout: 5000 }).catch(() => '');
      const parsed = parseCompactNumber(text);
      if (parsed !== null) {
        return { total: parsed, rawText: text, selector };
      }
    }
  }

  return null;
}

async function extractMetricFromBodyText(page, patterns) {
  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) {
      const parsed = parseCompactNumber(match[1]);
      if (parsed !== null) {
        return { total: parsed, rawText: match[0], selector: 'body_text_pattern' };
      }
    }
  }

  return null;
}

async function extractFollowers(page) {
  const result = await extractMetricFromSelectors(page, [
    `a[href="/${username}/followers"]`,
    `a[href$="/${username}/followers"]`,
    `a[href$="/followers"]`
  ]);

  if (result) return result;

  const bodyResult = await extractMetricFromBodyText(page, [
    /([0-9][0-9,.]*\s*[KMB]?)\s+Followers/i,
    /([0-9][0-9,.]*\s*[KMB]?)\s+подписчик/i,
    /([0-9][0-9,.]*\s*[KMB]?)\s+подписчиков/i
  ]);

  if (bodyResult) return bodyResult;

  throw new Error('Could not extract followers count from X profile page');
}

async function collectTotalFollowersLoggedOut(browser) {
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  const profileUrl = `https://x.com/${username}`;

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    const followers = await extractFollowers(page);
    console.log(`Collected logged-out total followers: ${followers.total}; raw=${followers.rawText}`);
    return followers;
  } finally {
    await context.close().catch(() => {});
  }
}

async function collectUserCellsFromPage(page) {
  const selectorCandidates = [
    '[data-testid="primaryColumn"] [data-testid="UserCell"]',
    'main [data-testid="UserCell"]'
  ];

  for (const selector of selectorCandidates) {
    const rawCells = await page
      .locator(selector)
      .evaluateAll((cells) => cells.map((cell, index) => ({
        index,
        text: cell.innerText || '',
        hrefs: Array.from(cell.querySelectorAll('a[href^="/"]'))
          .map((link) => link.getAttribute('href'))
          .filter(Boolean)
      })))
      .catch(() => []);

    const cells = [];

    for (const cell of rawCells) {
      const handle = cell.hrefs.map(normalizeHandleFromHref).find(Boolean);

      if (handle && handle !== username.toLowerCase()) {
        cells.push({
          handle,
          text: compactText(cell.text),
          domIndex: cell.index,
          selector
        });
      }
    }

    if (cells.length > 0) {
      console.log(`Verified follower cell selector used: ${selector}`);
      return cells;
    }
  }

  return [];
}

async function countVerifiedFollowersFromList(context) {
  const page = await context.newPage();
  const verifiedUrl = `https://x.com/${username}/verified_followers`;

  try {
    await page.goto(verifiedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);

    const currentUrl = page.url();
    console.log(`Verified followers page URL after load: ${currentUrl}`);

    if (!currentUrl.includes('/verified_followers')) {
      const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
      console.log(`Verified followers page redirected away. First body text: ${bodyText.slice(0, 500)}`);
      return null;
    }

    const bodyResult = await extractMetricFromBodyText(page, [
      /([0-9][0-9,.]*\s*[KMB]?)\s+Verified followers/i,
      /Verified followers\s+([0-9][0-9,.]*\s*[KMB]?)/i
    ]);

    if (bodyResult) {
      return {
        ...bodyResult,
        rawText: `${bodyResult.rawText}; url=${verifiedUrl}`,
        selector: 'verified_followers_page_text'
      };
    }

    const seen = new Map();
    let stableScrolls = 0;
    let previousSize = 0;

    for (let i = 0; i < 80; i++) {
      const cells = await collectUserCellsFromPage(page);

      for (const cell of cells) {
        if (!seen.has(cell.handle)) {
          seen.set(cell.handle, {
            ...cell,
            firstSeenScroll: i + 1
          });
        }
      }

      if (seen.size === previousSize) {
        stableScrolls += 1;
      } else {
        stableScrolls = 0;
        previousSize = seen.size;
      }

      if (stableScrolls >= 5) {
        break;
      }

      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(1500);
    }

    if (seen.size > 0) {
      const orderedEntries = Array.from(seen.entries()).map(([handle, cell], index) => ({
        index: index + 1,
        handle,
        text: cell.text,
        firstSeenScroll: cell.firstSeenScroll,
        domIndex: cell.domIndex
      }));

      const orderedHandles = orderedEntries.map((entry) => `${entry.index}:${entry.handle}`).join(',');
      const cellDetails = orderedEntries
        .map((entry) => `${entry.index}:${entry.handle}|scroll=${entry.firstSeenScroll}|dom=${entry.domIndex}|text=${entry.text}`)
        .join(' || ');
      const sortedHandles = orderedEntries.map((entry) => entry.handle).sort();

      console.log(`Verified follower handles ordered (${orderedEntries.length}): ${orderedHandles}`);
      console.log(`Verified follower cell details (${orderedEntries.length}): ${cellDetails}`);
      console.log(`Verified follower handles sorted (${sortedHandles.length}): ${sortedHandles.join(',')}`);

      return {
        total: seen.size,
        rawText: `counted_visible_verified_followers=${seen.size}; ordered_handles=${orderedHandles}; url=${verifiedUrl}; method=primary_column_unique_user_cells`,
        selector: 'verified_followers_primary_column_count'
      };
    }

    const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    console.log(`Verified followers page did not expose a count or user cells. First body text: ${bodyText.slice(0, 500)}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function collectVerifiedFollowersLoggedIn(browser) {
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  try {
    await addXAuthCookies(context);
    return await countVerifiedFollowersFromList(context);
  } finally {
    await context.close().catch(() => {});
  }
}

async function sendAccountSnapshot({ date, followers, verifiedFollowers }) {
  const payload = {
    token,
    date,
    username,
    followers_total: followers.total,
    source: 'x_public_page_total_followers_logged_out_playwright_github_actions',
    raw_text: followers.rawText || ''
  };

  if (verifiedFollowers) {
    payload.verified_followers_total = verifiedFollowers.total;
    payload.verified_source = `x_logged_in_verified_followers_${verifiedFollowers.selector}`;
    payload.verified_raw_text = verifiedFollowers.rawText || '';
  }

  const response = await fetch(webappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();
  console.log(response.status, responseText);

  if (!response.ok) {
    throw new Error(`Web app returned HTTP ${response.status}: ${responseText}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Web app did not return JSON: ${responseText}`);
  }

  if (!data.ok) {
    throw new Error(`Web app returned error: ${responseText}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  try {
    const followers = await collectTotalFollowersLoggedOut(browser);
    const verifiedFollowers = await collectVerifiedFollowersLoggedIn(browser);

    if (verifiedFollowers && verifiedFollowers.total === followers.total && verifiedFollowers.selector !== 'verified_followers_page_text') {
      console.log(`Verified followers matched total followers (${verifiedFollowers.total}); treating as suspicious and ignoring verified snapshot.`);
    }

    const safeVerifiedFollowers =
      verifiedFollowers && !(verifiedFollowers.total === followers.total && verifiedFollowers.selector !== 'verified_followers_page_text')
        ? verifiedFollowers
        : null;

    const today = new Date().toISOString().slice(0, 10);

    await sendAccountSnapshot({
      date: today,
      followers,
      verifiedFollowers: safeVerifiedFollowers
    });

    console.log(`Collected @${username}: ${followers.total} total followers`);

    if (safeVerifiedFollowers) {
      console.log(`Collected @${username}: ${safeVerifiedFollowers.total} verified followers`);
    } else {
      console.log(`Verified followers count was not visible for @${username}; skipped verified value.`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
