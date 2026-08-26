# Tool Findy

Tool Findy is a local-first inventory for tools and miscellany. It runs as an installable website on Windows and macOS, works offline for normal inventory work, keeps an append-only device history, exports portable JSON backups, and synchronizes with a human-readable Google Sheet.

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
5. In Tool Findy, choose **Connect sheet**, then paste the OAuth client ID and the Sheet URL.

Tool Findy creates `Items`, `Locations`, `History`, and `Settings` tabs when they are missing. The OAuth client ID and Sheet ID are stored in IndexedDB on the device; the Google access token is kept in memory only for the current session.

## Local data and backups

- `Items`, `Locations`, change history, settings, and daily snapshots live in IndexedDB.
- Each item or location change creates one or more immutable history events.
- **Backup** downloads a self-contained JSON package with the current records and full local history.
- **Restore** validates a Tool Findy JSON backup, previews its record counts, and replaces local items, locations, and history only after confirmation. Google connection settings remain unchanged, and a pre-restore recovery snapshot is saved automatically.
- Google Sheets remains the readable cloud copy and synchronization target.

## AI-assisted sorting inbox

Tool Findy automatically treats the existing active location named `to be sorted` as its sorting inbox. **Copy chat prompt** creates a self-contained prompt with waiting item details, the location hierarchy, a small sample of item names per location, and an exact JSON response format. Paste that prompt into the chat of your choice, then paste its response back into Tool Findy.

Tool Findy makes no AI API requests and needs no AI API key. It validates every returned item and destination before creating a local review draft. Choose another existing or proposed destination, accept or skip each row, then apply all accepted rows in one transaction. A pre-apply snapshot and normal unsynced history events are created, so resulting item moves and new locations use the existing Google Sheets sync.

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
