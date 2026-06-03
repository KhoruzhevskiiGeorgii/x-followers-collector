# X followers collector

Free prototype for collecting the current follower count of `@sphere_homotopy` into Google Sheets.

## What it does

GitHub Actions runs `collect-followers.js` daily and on manual dispatch. The script opens the public X profile with Playwright, extracts the visible follower count, and sends it to a Google Apps Script Web App.

The Apps Script writes into the existing spreadsheet tab:

```text
date | username | followers_total | followers_net_growth | source | collected_at | raw_text
```

## Required GitHub Actions secrets

Repository settings:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Add:

```text
WEBAPP_URL
INGEST_TOKEN
```

`WEBAPP_URL` is the deployed Apps Script Web App `/exec` URL.

`INGEST_TOKEN` must be exactly the same value as the Apps Script script property `INGEST_TOKEN`.

## Manual run

Open:

```text
Actions -> collect-x-followers -> Run workflow
```

## Notes

This is an unofficial free collector. It can break if X changes the public profile page, blocks headless browsers, or shows a login wall.
