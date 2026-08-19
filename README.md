# Findry

Findry is a local-first inventory for tools and miscellany. It runs as an installable website on Windows and macOS, works offline, keeps an append-only device history, exports portable JSON backups, and synchronizes with a human-readable Google Sheet.

Sync is disabled by default. The sidebar switch persists on the device; while it is off, the interface performs no Google or other internet requests.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Production checks:

```bash
npm run build
npm test
npm run build:mobile-web
```

## Connect Google Sheets

1. Create a Google Cloud project and enable the Google Sheets API.
2. Create a Web application OAuth client.
3. Add the website's exact origin to **Authorized JavaScript origins**. For local development, add the printed localhost origin as well.
4. Create or choose a Google Sheet.
5. In Findry, choose **Connect sheet**, then paste the OAuth client ID and the Sheet URL.

Findry creates `Items`, `Locations`, `History`, and `Settings` tabs when they are missing. The OAuth client ID and Sheet ID are stored in IndexedDB on the device; the Google access token is kept in memory only for the current session.

## Local data and backups

- `Items`, `Locations`, change history, settings, and daily snapshots live in IndexedDB.
- Each item or location change creates one or more immutable history events.
- **Backup** downloads a self-contained JSON package with the current records and full local history.
- Google Sheets remains the readable cloud copy and synchronization target.

## Keyboard commands

- `/` or `Ctrl/Command + K`: focus search
- `N`: create an item or location
- `E`: edit the selected item
- `Arrow Up/Down` or `J/K`: move through inventory
- `Enter`: open the selected item
- `Ctrl/Command + S`: save an open form
- `Escape`: close a dialog
- `?`: show shortcut help

## Android

`npm run build:mobile-web` creates a fully local mobile bundle in `mobile-dist`. The Capacitor configuration is in `capacitor.config.json`; detailed native setup notes are in `mobile/README.md`.

## Portable Windows package

`portable-windows` contains the dependency-free localhost server and double-click launcher used in the standalone Windows package. The packaged `app` directory comes from `npm run build:mobile-web`, and the packaged `runtime` directory contains the Windows Node.js executable. The server binds only to `127.0.0.1:4173`.
