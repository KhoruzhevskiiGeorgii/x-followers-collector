import { chromium } from 'playwright';

const username = (process.env.X_USERNAME || 'sphere_homotopy').replace(/^@/, '').trim();
const webappUrl = process.env.WEBAPP_URL;
const token = process.env.INGEST_TOKEN;

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

async function extractFollowers(page) {
  const result = await extractMetricFromSelectors(page, [
    `a[href="/${username}/followers"]`,
    `a[href$="/${username}/followers"]`,
    `a[href$="/followers"]`
  ]);

  if (result) return result;

  const bodyText = await page.locator('body').innerText({ timeout: 10000 });
  const patterns = [
    /([0-9][0-9,.]*\s*[KMB]?)\s+Followers/i,
    /([0-9][0-9,.]*\s*[KMB]?)\s+подписчик/i,
    /([0-9][0-9,.]*\s*[KMB]?)\s+подписчиков/i
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) {
      const parsed = parseCompactNumber(match[1]);
      if (parsed !== null) {
        return { total: parsed, rawText: match[0], selector: 'body_text_pattern' };
      }
    }
  }

  throw new Error('Could not extract followers count from X profile page');
}

async function extractVerifiedFollowers(page) {
  return extractMetricFromSelectors(page, [
    `a[href="/${username}/verified_followers"]`,
    `a[href$="/${username}/verified_followers"]`,
    `a[href$="/verified_followers"]`
  ]);
}

async function sendSnapshot({ date, snapshotUsername, followersTotal, source, rawText }) {
  const payload = {
    token,
    date,
    username: snapshotUsername,
    followers_total: followersTotal,
    source,
    raw_text: rawText || ''
  };

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
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  const profileUrl = `https://x.com/${username}`;

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const followers = await extractFollowers(page);
  const verifiedFollowers = await extractVerifiedFollowers(page);

  await browser.close();

  const today = new Date().toISOString().slice(0, 10);

  await sendSnapshot({
    date: today,
    snapshotUsername: username,
    followersTotal: followers.total,
    source: 'x_public_page_total_followers_playwright_github_actions',
    rawText: followers.rawText
  });

  console.log(`Collected @${username}: ${followers.total} total followers`);

  if (verifiedFollowers) {
    await sendSnapshot({
      date: today,
      snapshotUsername: `${username}_verified`,
      followersTotal: verifiedFollowers.total,
      source: 'x_public_page_verified_followers_playwright_github_actions',
      rawText: verifiedFollowers.rawText
    });

    console.log(`Collected @${username}: ${verifiedFollowers.total} verified followers`);
  } else {
    console.log(`Verified followers count was not visible for @${username}; skipped verified snapshot.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
