# Android shell

`npm run build:mobile-web` creates a fully local web bundle in `mobile-dist`. The bundle uses the same interface, IndexedDB cache, history, backup export, and Sheets sync code as the website.

To create the Android project, install `@capacitor/core`, `@capacitor/android`, and `@capacitor/cli`, then run `npx cap add android` followed by `npx cap sync android`. Register `app.findry.inventory` as an Android OAuth client in the same Google Cloud project as the web client.

The browser build uses Google Identity Services. A production APK should acquire the Sheets OAuth token through Android Credential Manager (or a maintained Capacitor Google-auth plugin) and pass it to `setGoogleAccessToken()` in `lib/google-sheets.ts`. This keeps native authentication separate while reusing the complete Sheets transport and merge logic.

For stronger Android persistence, a Capacitor SQLite adapter can replace `lib/local-store.ts`; the UI and data model do not depend on server APIs.
