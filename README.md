# SillyTavern-AutoWallpaper

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) third-party extension that **automatically keeps the chat background in sync with the current roleplay scene**.

Every N completed assistant replies (default 2 — counting starts only after the assistant finishes a reply) it:

1. Sends only the latest exchange to a text model (default `google/gemma-4-26b-a4b-it`) in **one call**, as a **structured message array** — a `developer` message with `<tags>`-delimited sections (cached-wallpaper inventory, output format, rules), the conversation as `user`/`assistant` turns, and a final task. The model either picks an exact cached wallpaper to **reuse** or proposes a new people-free **setting description + clear name** to generate.
2. If the model chose a cached wallpaper, it applies it directly (no image generation cost).
3. Otherwise it generates a new wallpaper with an OpenRouter image model (default `krea/krea-2-medium-turbo`) and sets it as the SillyTavern background.

Generated wallpapers are **portrait (9:16)**, scene-only (no people/characters/text), and shown with ST's `cover` background fit. Cached wallpapers appear as a scrollable thumbnail library in the settings panel.

## Installation

1. In SillyTavern, open **Extensions → Install Extension** (the "Install extension" button in the Extensions drawer).
2. Paste this repository URL:
   ```
   https://github.com/andrewmanueI/SillyTavern-AutoWallpaper
   ```
   (optionally specify a branch) and install.
3. Reload the page.

## Setup

1. Make sure you have an API connection configured in SillyTavern (for chat replies).
2. Open **Extensions → Auto-Wallpaper** settings and paste your **OpenRouter API key** (required — the extension calls OpenRouter's Image API directly for wallpapers).
3. **Text provider** selector: **OpenRouter (direct)** uses the key above + the **Text model** field; **SillyTavern API (active connection)** uses whatever connection is active in ST's API Connections (no extra key needed). Optionally adjust: text model (scene analysis + cache match), image model, aspect ratio (`9:16`), crop ratio (used only for non-cover fit modes), background fit (`cover`), assistant replies between updates.

That's it — chat normally and the background updates itself as the scene changes. You can also force an update with the **"Update now"** button, the wand-menu **"Auto Wallpaper"** button, or the **`/wallpaper`** slash command.

## Files

- `manifest.json` — extension metadata (`display_name`, `js`, `css`, hooks).
- `index.js` — the extension logic (auto-trigger, scene analysis, cache match, image generation, background application).
- `settings.html` / `library.html` — settings panel + cached-wallpaper library templates.
- `style.css` — library/panel styling.

## Notes

- Wallpapers are cached in `extensionSettings.auto_wallpaper.wallpaperCache` with a clear scene name; the actual image files live in ST's `backgrounds/` folder.
- "Clear cache" in the settings panel forces future scenes to regenerate instead of reusing.
- No API keys are stored in this repository — the key lives only in your local SillyTavern settings.
