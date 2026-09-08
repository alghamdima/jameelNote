# JameelNote presentation customization

This customization changes the displayed application name to JameelNote and
hides About (including its logo shortcut), analytics UI, updates, notification
settings, system popups, and external help links. Existing implementation code,
saved preferences, model downloads, and GitHub workflows are retained.

- `frontend/src/config/presentation.ts` controls UI visibility. Only Built-in AI
  and Custom Server (OpenAI) appear in provider selection. `showOtherAIProviders`
  restores the other options; their backend implementations remain enabled.
- `frontend/src/config/privacy.json` is shared by the frontend and Rust backend.
  Analytics, update checks/installations, and opening external links are disabled
  independently of UI visibility and previously saved analytics consent.
- `frontend/src-tauri/src/presentation.rs`: set `SHOW_UPDATES` to `true` to restore
  the tray update item, and `SHOW_SYSTEM_NOTIFICATIONS` to `true` to restore OS
  popups. Rebuild the desktop app after changing these constants.
- No startup update timer is scheduled; direct update service calls cannot check
  or install updates, and the native updater plugin is not registered. Restoring
  updates requires both the privacy policy and presentation flags. The original
  endpoint/signing settings remain in source and must be reviewed before reuse.
- The PostHog client is never constructed while analytics is disabled. The
  analytics initialization command also rejects previously enabled consent.
- Model downloads remain available. AI provider networking is unchanged by
  explicit request: a custom server (or a previously saved hidden provider) can
  transmit meeting content to its configured endpoint. This is not a blanket
  network block or a guarantee that all processing stays on-device.
- In-app success/error messages, permission prompts, and recording progress
  remain visible.
- `tauri.conf.json` changes the display name/title and tightens webview CSP.
  Native model/provider requests are unaffected by webview CSP. The app
  identifier, internal package/binary names, data paths, images, colors, links,
  license notices, and release workflows retain their original values.
- When merging upstream changes, review new display strings, analytics clients,
  update checks, and notification entry points. These small changes reduce
  merge conflicts but cannot eliminate them.

Validation: `node --test tests/lib/privacy.test.cjs` from `frontend` checks that
manual/automatic updates and analytics activation do not call their services.
Rust policy tests require the repository's normal Rust build environment.
Rebuild/install the desktop application to see these source changes; an existing
installed Meetily executable is not modified by editing this repository.
