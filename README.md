# SillyTavern-Visualize

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) third-party extension that **automatically keeps the chat background in sync with the current roleplay scene** — and, through a shared community library, gets cheaper the more people use it.

Every N completed assistant replies (default 2 — counting starts only after the assistant finishes a reply) it:

1. Sends only the latest exchange to a text model (default `inclusionai/ling-2.6-flash` via `novita`) in **one call**, as a **structured message array** — a `developer` message with `<tags>`-delimited sections (cached-wallpaper inventory, output format, rules), the conversation as `user`/`assistant` turns, and a final task. The model either picks an exact cached wallpaper to **reuse** or proposes a new people-free **setting description + clear name** to generate.
2. If the model chose a cached wallpaper, it applies it directly (no image generation cost).
3. Otherwise it generates a new wallpaper with an OpenRouter image model (default `krea/krea-2-medium-turbo`) and sets it as the SillyTavern background.

Generated wallpapers are **portrait (9:16)**, scene-only (no people/characters/text), and shown with ST's `cover` background fit. Cached wallpapers appear as a scrollable thumbnail library in the settings panel.

## Installation

1. In SillyTavern, open **Extensions → Install Extension** (the "Install extension" button in the Extensions drawer).
2. Paste this repository URL:
   ```
   https://github.com/andrewmanueI/SillyTavern-Visualize
   ```
   (optionally specify a branch) and install.
3. Reload the page.

## Setup

1. Make sure you have an API connection configured in SillyTavern (for chat replies).
2. Open **Extensions → Visualize** settings and paste your **OpenRouter API key** — required, because both scene analysis and wallpaper generation call OpenRouter. It stays in your SillyTavern settings and never ships with the extension.

### Why each model setting exists

Model selectors are populated from [OpenRouter's model API](https://openrouter.ai/docs/api-reference/list-available-models):

- **Text model provider** — the OpenRouter vendor (e.g. `inclusionai`, `google`, `deepseek`). Kept separate from the model so you only browse one vendor's catalog at a time.
- **Text model** — the model that reads the latest exchange and decides whether to *reuse* an existing wallpaper or propose a new scene (default `inclusionai/ling-2.6-flash`). A small, fast model keeps the analysis cheap; a built-in retry loop absorbs flaky responses.
- **Inference provider** — *which* OpenRouter endpoint actually serves the text model (default `novita`), populated from the model's real endpoints. Pinning one gives consistent routing; `Auto` lets OpenRouter load-balance. The list refetches when you change models, so you can never pin an endpoint that can't serve it.
- **Image model** — the model that paints new wallpapers when no cached scene matches (default `krea/krea-2-medium-turbo`), listed **cheapest first** so you can trade quality for cost.
- **Assistant replies between updates** — how many completed assistant replies pass before the scene is re-evaluated (default 2). Lower = more responsive; higher = fewer model calls.
- **Aspect ratio / crop ratio / background fit** — output presentation: the requested canvas, an optional pre-crop for non-cover fits, and how ST displays the wallpaper.

### Shared library

The extension connects to a **community wallpaper library**: every install reads it for reuse (so most scenes never need generating) and — with the **"Share generated wallpapers to the library"** toggle (default ON) — contributes its own. Turn the toggle off to use the library read-only. Wallpapers are stored as small WebP files with content-hash dedup, so duplicates never waste space and everyone's library stays fast.

That's it — chat normally and the background updates itself as the scene changes. You can also force an update with the **"Update now"** button, the wand-menu **"Visualize"** button, or the **`/wallpaper`** slash command.

## Files

- `manifest.json` — extension metadata (`display_name`, `js`, `css`, hooks).
- `index.js` — the extension logic (auto-trigger, scene analysis, cache match, image generation, background application).
- `settings.html` / `library.html` — settings panel + wallpaper-library templates.
- `style.css` — library/panel styling.

## Notes

- Wallpapers are cached under `extensionSettings.visualize.wallpaperCache` with a clear scene name; the actual image files live in ST's `backgrounds/` folder (or are served from the shared library).
- "Clear cache" in the settings panel forces future scenes to regenerate instead of reusing.
- No API keys are stored in this repository — the key lives only in your local SillyTavern settings.
