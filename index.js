// Visualize: automatically keeps the background wallpaper in sync with the
// current roleplay scene.
//
// Every N completed assistant replies (default 2) it sends the latest exchange to
// the text model in a single call as a structured message array: a developer
// message (with <tags>-delimited sections carrying the full cached-wallpaper
// inventory, output format, and rules) + the conversation as user/assistant turns
// + a final task. The model list is fetched from OpenRouter's /models API: text
// model + provider (vendor) are dropdowns, and the image model dropdown lists
// image-generation models sorted by price low -> high. The model either picks a
// matching cached wallpaper (reuse) or proposes a new people-free setting
// (generate). New wallpapers are produced via an OpenRouter image model.
//
// Counting starts only after the assistant finishes a turn: the user's own send
// doesn't advance the counter.

import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { background_settings } from '../../../backgrounds.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const MODULE_NAME = 'visualize';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// The shared community library every install reads from and contributes to.
// Baked in so users never have to see or configure the endpoint.
const DEFAULT_REMOTE_URL = 'https://visualize-storage.andrewmanuelcool.workers.dev';

const defaultSettings = Object.freeze({
    imageKey: '',
    imageModel: 'krea/krea-2-medium-turbo',
    aspectRatio: '9:16',
    cropRatio: '1:4',
    fitMode: 'cover',
    textVendor: 'inclusionai',
    textModel: 'inclusionai/ling-2.6-flash',
    inferenceProvider: 'novita', // OpenRouter inference provider tag ('' = OpenRouter default routing)
    remoteApiUrl: DEFAULT_REMOTE_URL, // shared community library endpoint (empty = offline/local)
    sharePublic: true, // auto-share generated wallpapers to the community library
    contributorId: '', // random per-install id used for library uploads (auto-generated)
    wallpaperEnabled: true,
    messagesBetweenUpdates: 2,
    wallpaperCache: [],
    libraryView: 'local', // which library list the panel shows: 'local' cache or 'global' shared library
});

let messageCount = 0;
let isUpdating = false;

const FADE_LAYER_ID = 'stv_bg_fade';
const FADE_MS = 700;

// Retry policy for the text-model call. Small MoE models (e.g. ling-2.6-flash)
// intermittently return upstream 5xx errors, empty completions, or non-JSON text,
// so we loop with backoff until we get a valid, decidable response.
const API_MAX_ATTEMPTS = 3;       // transient HTTP failures (429 / 5xx / network)
const API_RETRY_DELAY_MS = 1000;  // base delay, multiplied by attempt
const TEXT_MAX_ATTEMPTS = 3;      // invalid / empty / undecidable responses
const TEXT_RETRY_DELAY_MS = 800;  // base delay, multiplied by attempt

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generates the per-install contributor id. crypto.randomUUID is only available
 * in secure contexts (HTTPS or localhost) — on plain http://LAN-IP installs it
 * is undefined, which would otherwise break activation. Always falls back.
 */
function generateContributorId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return `viz-${crypto.randomUUID().replaceAll('-', '')}`;
        }
    } catch { /* fall through to fallback */ }
    const rand = () => Math.random().toString(36).slice(2, 10);
    return `viz-${rand()}${rand()}${Date.now().toString(36)}`;
}

function getSettings() {
    const { extensionSettings } = getContext();
    // Migrate settings from the old 'auto_wallpaper' and 'chat_recap' keys
    // (extension renamed to Visualize).
    if (!extensionSettings[MODULE_NAME] && extensionSettings.auto_wallpaper) {
        extensionSettings[MODULE_NAME] = extensionSettings.auto_wallpaper;
        delete extensionSettings.auto_wallpaper;
    }
    if (!extensionSettings[MODULE_NAME] && extensionSettings.chat_recap) {
        extensionSettings[MODULE_NAME] = extensionSettings.chat_recap;
        delete extensionSettings.chat_recap;
    }
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    delete extensionSettings[MODULE_NAME].imageSize; // legacy key, replaced by aspectRatio
    delete extensionSettings[MODULE_NAME].textProvider; // legacy transport selector (openrouter|st), replaced by textVendor
    delete extensionSettings[MODULE_NAME].remoteApiKey; // legacy API-key auth, replaced by contributorId + public writes
    // Auto-generate the per-install contributor id on first use of remote storage.
    if (!extensionSettings[MODULE_NAME].contributorId) {
        extensionSettings[MODULE_NAME].contributorId = generateContributorId();
    }
    return extensionSettings[MODULE_NAME];
}

function getCache() {
    const cache = getSettings().wallpaperCache;
    return Array.isArray(cache) ? cache : [];
}

// --- Shared library storage -------------------------------------------------------
// When remoteApiUrl is set, wallpapers are stored in the public community
// library: WebP full + thumbnail per wallpaper, deduped by content
// hash, indexed server-side. Reads are public; uploads are tagged with a per-install
// contributorId (no secret shipped) and rate-limited. If the
// sharePublic toggle is off, generated wallpapers stay local but the shared
// library is still used for reading/reuse. Otherwise the old local ST background
// storage is used. Cache entries carry { filename } locally or { url, thumb, id }
// remotely.

function isRemoteMode(settings) {
    return !!(settings.remoteApiUrl);
}

async function remoteFetch(settings, path, options = {}) {
    const base = String(settings.remoteApiUrl).replace(/\/+$/, '');
    const res = await fetch(`${base}${path}`, options);
    if (!res.ok) {
        throw new Error(`storage API ${res.status} ${res.statusText}`.trim());
    }
    return res;
}

/** Deletes one of this install's own uploads from the public library. */
async function deleteRemoteWallpaper(settings, id) {
    return remoteFetch(settings, `/api/wallpapers/${id}`, {
        method: 'DELETE',
        headers: { 'X-Contributor-Id': settings.contributorId },
    });
}

/**
 * Semantic search of the shared library. Sends the raw query text; the worker
 * embeds it with Workers AI (free tier) — no OpenRouter embedding cost here.
 * Returns cache-entry-shaped candidates (or [] on any failure).
 */
async function remoteSimilar(settings, text, limit = 10) {
    if (!isRemoteMode(settings)) return [];
    try {
        const res = await remoteFetch(settings, '/api/wallpapers/similar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, limit }),
        });
        const data = await res.json();
        return (data.results || []).map(w => ({
            name: w.name,
            description: w.description || '',
            filename: '',
            id: w.id,
            own: w.contributorId === settings.contributorId,
            url: w.urls.full,
            thumb: w.urls.thumb,
            score: w.score,
        }));
    } catch (err) {
        console.warn('[visualize] remote similar search failed', err?.message);
        return [];
    }
}

/**
 * Re-encodes an image data URL as WebP (optionally downscaled to maxWidth),
 * returning a Blob. WebP is ~5-10x smaller than PNG for photographic scenes.
 */
async function encodeWebp(dataUrl, maxWidth = 0) {
    const img = await loadImage(dataUrl);
    const scale = maxWidth > 0 && img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const webpDataUrl = canvas.toDataURL('image/webp', 0.85);
    const mediaType = (webpDataUrl.match(/data:([^;]+)/) || [])[1] || 'image/webp';
    return base64ToBlob(webpDataUrl.split(',')[1], mediaType);
}

async function uploadRemote(settings, fullBlob, thumbBlob, setting) {
    // The worker embeds the scene (name + description) server-side with Workers
    // AI (free tier), so this install spends nothing on embeddings. The name and
    // description fields below are all the worker needs.
    const form = new FormData();
    form.append('image', new File([fullBlob], `visualize-${setting.name}.webp`, { type: 'image/webp' }));
    form.append('thumb', new File([thumbBlob], 'thumb.webp', { type: 'image/webp' }));
    form.append('name', setting.name);
    form.append('description', setting.description);
    form.append('fit', settings.fitMode);
    form.append('aspect', settings.aspectRatio);
    form.append('contributorId', settings.contributorId);
    const res = await remoteFetch(settings, '/api/wallpapers', { method: 'POST', body: form });
    return res.json();
}

/** Pulls wallpapers uploaded from anywhere (other devices) into the local cache. */
async function syncRemoteCache(settings) {
    if (!isRemoteMode(settings)) return;
    try {
        const data = await (await remoteFetch(settings, '/api/wallpapers?limit=500')).json();
        const cache = getCache();
        const seen = new Set(cache.map(e => e.url));
        for (const w of data.wallpapers || []) {
            if (w?.urls?.full && !seen.has(w.urls.full)) {
                cache.push({
                    name: w.name,
                    description: w.description || '',
                    filename: '',
                    id: w.id,
                    own: w.contributorId === settings.contributorId,
                    url: w.urls.full,
                    thumb: w.urls.thumb,
                });
            }
        }
        saveSettingsDebounced();
    } catch (err) {
        console.warn('[visualize] remote cache sync failed', err?.message);
    }
}

/**
 * Live list of the whole shared library (cache-entry shaped, `own` flagged).
 * Returns null on failure so the UI can distinguish "unreachable" from "empty".
 */
async function fetchGlobalLibrary(settings) {
    if (!isRemoteMode(settings)) return null;
    try {
        const data = await (await remoteFetch(settings, '/api/wallpapers?limit=500')).json();
        return (data.wallpapers || []).map(w => ({
            name: w.name,
            description: w.description || '',
            filename: '',
            id: w.id,
            own: w.contributorId === settings.contributorId,
            url: w.urls.full,
            thumb: w.urls.thumb,
        }));
    } catch (err) {
        console.warn('[visualize] global library fetch failed', err?.message);
        return null;
    }
}

// --- OpenRouter model catalog ---------------------------------------------------
// Fetched once. Two lists:
//   - text:  GET /api/v1/models — every model, grouped by vendor (first segment
//            of the model id). This is the chat-completions catalog.
//   - image: GET /api/v1/models?output_modalities=image — the genuine
//            image-generation models only (krea, FLUX, recraft, seedream,
//            gpt-image, gemini image, ...), each with per-image pricing
//            (pricing.image_output), ordered low -> high.
// The unfiltered /models list deliberately omits image-only models like krea,
// so the image selector MUST use the filtered endpoint.

let modelCatalog = null;

function parseImagePrice(model) {
    const raw = String(model.pricing?.image_output || '').trim();
    const num = Number.parseFloat(raw);
    return Number.isFinite(num) && num >= 0 ? num : NaN;
}

function formatImagePrice(price) {
    if (!Number.isFinite(price)) return 'n/a';
    if (price === 0) return 'free';
    // Trim to a readable width without trailing zeros: e.g. 0.000008 -> "$0.000008/img"
    let s;
    if (price >= 1) {
        s = price.toFixed(2).replace(/\.?0+$/, '');
    } else if (price >= 0.001) {
        s = price.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    } else {
        // small prices need more digits; cap at 9 then trim trailing zeros
        s = price.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
    }
    return `$${s}/img`;
}

async function fetchModelCatalog() {
    if (modelCatalog) return modelCatalog;
    const [chatRes, imageRes] = await Promise.all([
        fetch(`${OPENROUTER_BASE}/models`),
        fetch(`${OPENROUTER_BASE}/models?output_modalities=image`),
    ]);
    const chatData = await chatRes.json();
    const imageData = await imageRes.json();
    const all = chatData?.data || [];
    if (!chatRes.ok || !all.length) throw new Error(chatData?.error?.message || `models API ${chatRes.status}`);

    // Text selector: EVERYTHING OpenRouter lists, grouped by vendor.
    const models = all
        .map(m => ({
            id: m.id,
            name: m.name,
            imagePrice: parseImagePrice(m),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    const vendors = [...new Set(models.map(m => m.id.split('/')[0]))].sort((a, b) => a.localeCompare(b));

    // Image selector: the dedicated image-generation catalog (krea, FLUX, recraft,
    // ...), ordered purely by per-image price low -> high (unpriced sort last).
    const imageModels = (imageData?.data || [])
        .map(m => ({
            id: m.id,
            name: m.name,
            imagePrice: parseImagePrice(m),
        }))
        .sort((a, b) => {
            const pa = Number.isFinite(a.imagePrice) ? a.imagePrice : Infinity;
            const pb = Number.isFinite(b.imagePrice) ? b.imagePrice : Infinity;
            return pa - pb || a.id.localeCompare(b.id);
        });

    modelCatalog = { models, vendors, imageModels };
    return modelCatalog;
}

function ensureModelOption(select, value) {
    // If the saved model id isn't in the fetched list (e.g. removed model), append
    // it as a manual option so the saved value is never silently lost.
    if (value && ![...select.options].some(o => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = `${value} (saved)`;
        select.appendChild(opt);
    }
}

// --- Inference providers (per model) --------------------------------------------
// OpenRouter exposes the endpoints a model can be served from via
// GET /api/v1/models/<model>/endpoints -> { data: { endpoints: [...] } }.
// Each endpoint carries provider_name (display) and tag (the routing slug that
// `provider.only` accepts). Only providers that actually exist for the selected
// model are listed. Cached per model id.

let providerCache = {}; // model id -> [{ tag, name }]

async function fetchModelProviders(modelId) {
    if (!modelId) return [];
    if (providerCache[modelId]) return providerCache[modelId];

    let providers = [];
    try {
        const res = await fetch(`${OPENROUTER_BASE}/models/${modelId}/endpoints`);
        const data = await res.json();
        const endpoints = data?.data?.endpoints || [];
        const seen = new Set();
        for (const ep of endpoints) {
            if (ep?.tag && !seen.has(ep.tag)) {
                seen.add(ep.tag);
                const slash = ep.tag.indexOf('/');
                const suffix = slash !== -1 ? ep.tag.slice(slash + 1) : '';
                providers.push({
                    tag: ep.tag,
                    name: suffix ? `${ep.provider_name} (${suffix})` : (ep.provider_name || ep.tag),
                });
            }
        }
    } catch (err) {
        console.warn('[visualize] could not load inference providers', err?.message);
    }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    providerCache[modelId] = providers;
    return providers;
}

async function fillInferenceProviderSelect(modelId) {
    const select = $('#stv_inference_provider');
    if (!select.length) return;
    const providers = await fetchModelProviders(modelId);
    select.empty();
    select.append('<option value="">Auto (OpenRouter default)</option>');
    for (const p of providers) {
        select.append(`<option value="${p.tag}">${p.name}</option>`);
    }
    const current = getSettings().inferenceProvider;
    if (current && providers.some(p => p.tag === current)) {
        select.val(current);
    } else {
        // The saved provider isn't available for this model — reset to auto.
        select.val('');
        if (current) {
            getSettings().inferenceProvider = '';
            saveSettingsDebounced();
        }
    }
}

/**
 * Converts the recent chat messages into alternating user/assistant turns for the
 * text model, merging any consecutive same-role messages so providers that reject
 * repeated roles keep working.
 */
function toRoleTurns(messages) {
    const turns = [];
    for (const m of messages) {
        const role = m.is_user ? 'user' : 'assistant';
        const content = String(m.mes).trim();
        if (!content) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === role) {
            last.content += '\n\n' + content;
        } else {
            turns.push({ role, content });
        }
    }
    return turns;
}

/**
 * Builds the structured message array for the single decide call:
 *   - developer message carrying instructions, the cached-wallpaper inventory,
 *     the output format, and rules — each delimited with <tags>
 *   - the actual conversation as user/assistant turns
 *   - a final user message with the task
 */
function buildDecideMessages(messages, cache) {
    const inventory = cache.length
        ? cache.map(e => `- name: ${e.name}\n  description: ${e.description}`).join('\n')
        : '(the cache is empty — you must generate a new one)';

    const developerContent = [
        '<instructions>',
        'You choose the correct background wallpaper for a roleplay scene.',
        'Read the conversation below to understand the scene: location, time, weather, lighting, era, and objects.',
        '</instructions>',
        '',
        '<cached_wallpapers>',
        inventory,
        '</cached_wallpapers>',
        '',
        '<output_format>',
        'Respond with JSON only, using exactly one of these two shapes:',
        '1) {"action":"reuse","name":"<exact name from <cached_wallpapers>, verbatim>"}',
        '2) {"action":"generate","name":"<short kebab-case slug, 2-4 words>","description":"<1-2 sentences: location, time, weather, lighting, era, objects>"}',
        '</output_format>',
        '',
        '<rules>',
        '- Only reuse when a cached wallpaper matches the scene well; otherwise generate.',
        '- For generate, describe ONLY the physical setting: never mention people, characters, names, pronouns, creatures, or actions.',
        '- For generate, write the description as a photorealistic photography prompt: state the medium explicitly (e.g. "cinematic photograph", "photorealistic still") and use concrete, named lighting and material terms (e.g. "golden hour side lighting", "wet black stone", "volumetric fog", "harsh fluorescent overhead") instead of vague adjectives like "beautiful" or "premium."',
        '- Never invent or modify a cached name — copy it verbatim from <cached_wallpapers>.',
        '- Output raw JSON, no markdown fences, no commentary.',
        '</rules>',
    ].join('\n');

    return [
        { role: 'developer', content: developerContent },
        ...toRoleTurns(messages),
        { role: 'user', content: '<task>Choose a wallpaper for the scene in this conversation. Reply with the reuse or generate JSON exactly as specified in <output_format>.</task>' },
    ];
}

function isRetryableStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}

async function chatCompletion(messages, settings, maxTokens = 200) {
    let lastError = null;
    for (let attempt = 0; attempt < API_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await sleep(API_RETRY_DELAY_MS * attempt);
            console.warn(`[visualize] text API attempt ${attempt + 1}/${API_MAX_ATTEMPTS} after: ${lastError?.message}`);
        }
        try {
            const body = { model: settings.textModel, messages, max_tokens: maxTokens };
            // Pin inference to the user-chosen provider (only + no fallbacks) when
            // one is selected; otherwise let OpenRouter load-balance by default.
            if (settings.inferenceProvider) {
                body.provider = { only: [settings.inferenceProvider], allow_fallbacks: false };
            }
            const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.imageKey}`,
                },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) {
                lastError = new Error(data?.error?.message || `text API ${res.status}`);
                // Non-transient (e.g. 401 bad key) — retrying won't help.
                if (!isRetryableStatus(res.status)) throw lastError;
                continue;
            }
            return data.choices?.[0]?.message?.content?.trim() ?? '';
        } catch (err) {
            // Network-level failure — retry while attempts remain, else rethrow.
            lastError = err;
            if (attempt === API_MAX_ATTEMPTS - 1) throw err;
        }
    }
    throw lastError ?? new Error('text API failed');
}

function extractJson(raw) {
    let s = String(raw).trim()
        .replace(/^```[a-zA-Z]*\s*/, '')
        .replace(/\s*```\s*$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
        s = s.slice(start, end + 1);
    }
    return JSON.parse(s);
}

/**
 * Single text-model call that decides what to do with the wallpaper:
 * either reuse a cached one (returning its exact name) or propose a brand-new
 * people-free setting to generate. The full cached-wallpaper inventory rides in
 * the developer message, so the model has everything it needs in one shot.
 *
 * Loops with backoff until the model returns a VALID, decidable response:
 *   - empty output -> retry
 *   - unparseable / non-JSON -> retry
 *   - "reuse" naming a wallpaper that isn't in the cache -> retry (hallucinated)
 *   - anything that isn't a valid reuse or generate shape -> retry
 * After TEXT_MAX_ATTEMPTS it falls back to a generic scene (never hard-fails).
 *
 * `messages` are the recent ST chat message objects; they become the structured
 * user/assistant turns of the request.
 *
 * Returns { mode: 'reuse', entry } or { mode: 'generate', setting }.
 */
async function decideWallpaper(messages, cache, settings) {
    const requestMessages = buildDecideMessages(messages, cache);

    for (let attempt = 0; attempt < TEXT_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await sleep(TEXT_RETRY_DELAY_MS * attempt);
            console.warn(`[visualize] invalid text response, retrying ${attempt + 1}/${TEXT_MAX_ATTEMPTS}`);
            setLoading(true, `Analyzing scene… (retry ${attempt + 1}/${TEXT_MAX_ATTEMPTS})`);
        }

        let raw = '';
        try {
            raw = await chatCompletion(requestMessages, settings, 220);
        } catch (err) {
            // chatCompletion already retried transient failures; retry the whole
            // attempt while we have attempts left, otherwise propagate.
            console.warn('[visualize] text call failed', err?.message);
            if (attempt === TEXT_MAX_ATTEMPTS - 1) throw err;
            continue;
        }

        if (!raw) {
            console.warn('[visualize] text model returned empty output');
            continue;
        }

        let parsed = null;
        try {
            parsed = extractJson(raw);
        } catch {
            continue; // invalid JSON -> retry
        }

        // REUSE: model picked a cached name (possibly humanized — normalize it to
        // the same kebab-slug shape the generate names use before matching).
        const action = String(parsed?.action || '').toLowerCase();
        if (action === 'reuse' && parsed?.name) {
            const pick = String(parsed.name).trim().toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const entry = cache.find(e =>
                e.name.toLowerCase() === pick
                || pick.includes(e.name.toLowerCase())
                || e.name.toLowerCase().includes(pick),
            );
            // A reuse name that isn't in the cache is a hallucination -> retry.
            if (entry) return { mode: 'reuse', entry };
            console.warn(`[visualize] model reused unknown wallpaper "${parsed.name}"`);
            continue;
        }

        // GENERATE: explicit action, or any parseable object with a description.
        const description = String(parsed?.description || '').trim();
        if (description) {
            const name = String(parsed?.name || '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            if (name) return { mode: 'generate', setting: { name, description } };
        }

        // Any other shape -> retry.
        console.warn('[visualize] text model returned an unrecognizable response');
    }

    // Exhausted attempts: fall back to a generic scene rather than failing.
    return { mode: 'generate', setting: { name: `scene-${Date.now()}`, description: 'A generic atmospheric scene.' } };
}

function buildImagePrompt(settingDescription) {
    return [
        'A cinematic background wallpaper, tall portrait orientation.',
        'Absolutely NO people, NO humans, NO characters, NO figures, NO faces, NO hands, NO silhouettes, NO animals, NO creatures, NO text, NO watermark, NO logo.',
        'An empty, unoccupied scene. Depict ONLY the environment, atmosphere, lighting, and mood.',
        'Setting: ' + (settingDescription || '').trim(),
    ].join(' ');
}

function base64ToBlob(b64, mediaType) {
    const byteChars = atob(b64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        bytes[i] = byteChars.charCodeAt(i);
    }
    return new Blob([bytes], { type: mediaType || 'image/png' });
}

function extensionForMediaType(mediaType) {
    if (mediaType?.includes('webp')) return 'webp';
    if (mediaType?.includes('jpeg') || mediaType?.includes('jpg')) return 'jpg';
    return 'png';
}

/**
 * Parses a "W:H" ratio string (e.g. "1:4") into [widthRatio, heightRatio].
 */
function parseRatio(value) {
    const parts = String(value || '').split(':').map(x => parseFloat(x.trim()));
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] > 0 && parts[1] > 0) {
        return parts;
    }
    return [1, 4]; // safe default
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('failed to load image'));
        img.src = src;
    });
}

function dataURLToBlob(dataUrl) {
    const [meta, b64] = dataUrl.split(',');
    const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
    return base64ToBlob(b64, mediaType);
}

/**
 * Crops the image to the target portrait ratio (center strip). Returns the
 * original data URL if the image is already at/below the target ratio.
 */
async function cropToRatio(dataUrl, widthRatio, heightRatio) {
    const img = await loadImage(dataUrl);
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    const targetW = Math.round(sh * widthRatio / heightRatio);
    if (targetW >= sw) {
        return dataUrl;
    }
    const sx = Math.round((sw - targetW) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(img, sx, 0, targetW, sh, 0, 0, targetW, sh);
    return canvas.toDataURL('image/png');
}

/**
 * Sets ST's background fitting mode (classic/cover/contain/stretch/center).
 * Mirrors backgrounds.js setFittingClass — fitting is stored in background_settings.
 */
function setFitting(fitting) {
    const backgrounds = $('#bg1');
    for (const option of ['cover', 'contain', 'stretch', 'center']) {
        backgrounds.toggleClass(option, option === fitting);
    }
    background_settings.fitting = fitting;
}

// --- Background crossfade -------------------------------------------------------
// CSS cannot interpolate `background-image`, so a plain change of #bg1's image snaps
// instantly. To crossfade we preload the new wallpaper, paint it on a clone layer
// (#stv_bg_fade) that sits exactly over #bg1, fade the clone in over the old image,
// then commit the change to #bg1 (the element ST persists) and clean up.

function ensureFadeLayer() {
    let layer = document.getElementById(FADE_LAYER_ID);
    if (!layer) {
        layer = document.createElement('div');
        layer.id = FADE_LAYER_ID;
        layer.setAttribute('aria-hidden', 'true');
        $('#bg1').after(layer);
    }
    return layer;
}

function applyFittingToLayer(layer, fitMode) {
    switch (fitMode) {
        case 'contain':
            layer.style.backgroundSize = 'contain';
            break;
        case 'stretch':
            layer.style.backgroundSize = '100% 100%';
            break;
        case 'center':
            layer.style.backgroundSize = 'auto';
            break;
        default: // cover / classic
            layer.style.backgroundSize = 'cover';
    }
    layer.style.backgroundRepeat = 'no-repeat';
    layer.style.backgroundPosition = 'center';
}

function preloadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve(); // never block application on a preload failure
        img.src = src;
    });
}

async function transitionTo(preloadSrc, url) {
    await preloadImage(preloadSrc);

    const layer = ensureFadeLayer();
    applyFittingToLayer(layer, getSettings().fitMode);
    layer.style.backgroundImage = url;
    layer.style.opacity = '0';
    void layer.offsetWidth; // force reflow so the opacity transition kicks in
    layer.style.opacity = '1';

    await new Promise(resolve => setTimeout(resolve, FADE_MS));

    $('#bg1').css('background-image', url);
    layer.style.opacity = '0';
    setTimeout(() => {
        layer.style.backgroundImage = '';
    }, FADE_MS + 50);
}

/**
 * Applies a wallpaper to the background with a crossfade. `entry` is a cache
 * entry: { filename } for local ST backgrounds, or { url, thumb } for wallpapers
 * served from the shared library.
 */
async function applyBackground(entry) {
    const settings = getSettings();
    let preloadSrc;
    let url;
    if (entry?.url) {
        preloadSrc = entry.url;
        url = `url("${entry.url}")`;
    } else {
        preloadSrc = `backgrounds/${encodeURIComponent(entry.filename)}`;
        url = `url("${preloadSrc}")`;
    }
    // ST persists/applies the background through `background_settings` (the object
    // saved under the top-level "background" key and reloaded by loadBackgroundSettings),
    // so mutate it directly — writing to power_user.background is not read back.
    setFitting(settings.fitMode);
    background_settings.name = entry?.url ? `visualize:${entry.name}` : entry.filename;
    background_settings.url = url;
    await transitionTo(preloadSrc, url);
    saveSettingsDebounced();
}

async function generateWallpaper(setting, settings) {
    const prompt = buildImagePrompt(setting.description);

    const res = await fetch(`${OPENROUTER_BASE}/images/generations`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.imageKey}`,
        },
        body: JSON.stringify({
            model: settings.imageModel,
            prompt,
            n: 1,
            aspect_ratio: settings.aspectRatio,
        }),
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error?.message || `image API ${res.status}`);
    }
    const item = data?.data?.[0];
    if (!item?.b64_json) {
        throw new Error('image API returned no image');
    }

    // Generate at the max pre-crop resolution (Krea is capped at 1K). For
    // cover/contain/center fits the full 9:16 image is used as-is (ST crops/fits
    // it at display time); only fill-style modes pre-crop to cropRatio.
    const mediaType = item.media_type || 'image/png';
    const sourceDataUrl = `data:${mediaType};base64,${item.b64_json}`;
    const fitMode = settings.fitMode;
    let croppedDataUrl = sourceDataUrl;
    if (!['cover', 'contain', 'center'].includes(fitMode)) {
        const [wRatio, hRatio] = parseRatio(settings.cropRatio);
        croppedDataUrl = await cropToRatio(sourceDataUrl, wRatio, hRatio);
    }
    const blob = dataURLToBlob(croppedDataUrl);

    // Shared library: re-encode as WebP (full + 256px thumbnail) and upload
    // to the shared public library (only if the user's sharePublic toggle is on);
    // the returned URLs are what the background/library use.
    if (isRemoteMode(settings) && settings.sharePublic) {
        const fullBlob = await encodeWebp(croppedDataUrl, 0);
        const thumbBlob = await encodeWebp(croppedDataUrl, 256);
        const record = await uploadRemote(settings, fullBlob, thumbBlob, setting);
        const entry = {
            name: setting.name,
            description: setting.description,
            filename: '',
            id: record.id,
            url: record.urls.full,
            thumb: record.urls.thumb,
        };
        setLoading(true, 'Applying wallpaper…');
        setStep('apply');
        await applyBackground(entry);
        return entry;
    }

    // Local storage: upload to ST's backgrounds folder (also used when remote
    // mode is on but sharing is off — read the shared library, keep own images local).
    const filename = `visualize-${setting.name}.${extensionForMediaType(mediaType)}`;

    const formData = new FormData();
    formData.append('avatar', new File([blob], filename, { type: mediaType }));

    const ctx = getContext();
    const uploadRes = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });
    if (!uploadRes.ok) {
        throw new Error(`background upload failed (${uploadRes.status})`);
    }
    const savedName = (await uploadRes.text()).trim();

    const entry = { name: setting.name, description: setting.description, filename: savedName };
    setLoading(true, 'Applying wallpaper…');
    setStep('apply');
    await applyBackground(entry);
    return entry;
}

/**
 * Analyzes the latest chat exchange and sets a matching wallpaper
 * (reusing a cached one when possible).
 */
async function updateWallpaper() {
    if (isUpdating) return;
    const ctx = getContext();
    const settings = getSettings();

    if (!settings.imageKey) {
        console.warn('[visualize] no OpenRouter API key set');
        return;
    }

    const messages = (ctx.chat || []).filter(m => m && m.mes && !m.is_system);
    if (!messages.length) return;

    const recent = messages.slice(-Math.max(2, settings.messagesBetweenUpdates));

    isUpdating = true;
    setLoading(true, 'Analyzing scene…');
    setStep('analyze');
    try {
        let cache = getCache();
        // Remote mode: search the whole shared library semantically for the most
        // similar wallpapers and use those as the reuse inventory (the library
        // is far bigger than the local cache, so this is how crowd-sourcing pays
        // off — most scenes resolve to an existing wallpaper, no generation).
        if (isRemoteMode(settings)) {
            const queryText = recent.map(m => String(m.mes).trim()).filter(Boolean).join(' ');
            if (queryText) {
                setLoading(true, 'Searching shared library…');
                setStep('search');
                const similar = await remoteSimilar(settings, queryText, 10);
                if (similar.length) {
                    const merged = [];
                    for (const s of similar) {
                        if (!cache.some(e => e.url === s.url)) cache.push(s);
                        merged.push(s);
                    }
                    saveSettingsDebounced();
                    cache = merged;
                }
            }
        }
        setLoading(true, 'Analyzing scene…');
        setStep('analyze');
        const decision = await decideWallpaper(recent, cache, settings);
        if (decision.mode === 'reuse') {
            setLoading(true, 'Applying wallpaper…');
            setStep('apply');
            await applyBackground(decision.entry);
            return;
        }
        setLoading(true, 'Generating wallpaper…');
        setStep('generate');
        const result = await generateWallpaper(decision.setting, settings);
        if (!cache.some(e => e.name === result.name)) {
            cache.push(result);
            saveSettingsDebounced();
            await renderLibrary();
        }
    } catch (err) {
        console.error('[visualize] failed', err);
    } finally {
        isUpdating = false;
        setLoading(false);
    }
}

function onMessageSent() {
    // A turn is one *completed* assistant reply. The user's own message doesn't
    // count — the update fires after the assistant finishes the exchange.
    updateStatusUI();
}

function onMessageReceived(messageId, type) {
    // Skip the character's greeting / first-message emissions.
    if (type === 'first_message') return;
    const settings = getSettings();
    if (!settings.wallpaperEnabled) return;
    messageCount += 1;
    if (messageCount >= Math.max(1, settings.messagesBetweenUpdates)) {
        messageCount = 0;
        updateWallpaper();
    }
    updateStatusUI();
}

/**
 * Reflects the current "turns until next auto-update" counter and the
 * visualize on/off state in the settings panel and the wand-menu badge.
 * The progress bar fills as the counter advances toward the next update.
 */
function updateStatusUI() {
    const settings = getSettings();
    const enabled = settings.wallpaperEnabled;
    const total = Math.max(1, settings.messagesBetweenUpdates);
    const remaining = Math.max(0, total - messageCount);
    const progress = total > 0 ? Math.min(100, Math.round((messageCount / total) * 100)) : 0;
    const badge = $('#stv_recap_count');
    const turns = $('#stv_turns_left');
    const fill = $('#stv_turns_fill');
    const pct = $('#stv_turns_progress_label');
    if (badge.length) {
        badge.text(enabled ? String(remaining) : '');
        badge.toggleClass('cr-count-hidden', !enabled);
    }
    if (turns.length) turns.text(enabled ? String(remaining) : '—');
    if (fill.length) fill.css('width', `${progress}%`);
    if (pct.length) pct.text(enabled ? `${progress}%` : '');
}

/**
 * Shows/hides the in-panel busy indicator (current step + indeterminate bar)
 * and spins the wand-menu icon while a wallpaper update is in progress.
 */
function setLoading(active, text) {
    const spinner = $('#stv_status_loading');
    const turnsRow = $('#stv_status_turns');
    const icon = $('#stv_recap .extensionsMenuExtensionButton');
    if (active) {
        if (spinner.length) {
            spinner.css('display', '');
            if (text && $('#stv_status_loading_text').length) {
                $('#stv_status_loading_text').text(text);
            }
        }
        if (turnsRow.length) turnsRow.css('display', 'none');
        if (icon.length) icon.addClass('fa-spin');
    } else {
        if (spinner.length) spinner.css('display', 'none');
        if (turnsRow.length) turnsRow.css('display', '');
        if (icon.length) icon.removeClass('fa-spin');
        setStep(null);
        updateStatusUI();
    }
}

/**
 * Highlights the current pipeline step in the busy indicator: earlier steps
 * show as done, the current one as active, later ones as pending. Pass null
 * (or nothing) to clear all step states.
 */
function setStep(current) {
    const container = $('#stv_status_loading');
    if (!container.length) return;
    const steps = container.find('.stv-step');
    if (!steps.length) return;
    const order = ['analyze', 'search', 'generate', 'apply'];
    steps.each(function () {
        const key = $(this).data('step');
        const idx = order.indexOf(key);
        const curIdx = order.indexOf(current);
        $(this)
            .toggleClass('stv-step-done', current && idx >= 0 && curIdx >= 0 && idx < curIdx)
            .toggleClass('stv-step-active', current && key === current);
    });
}

/**
 * Renders the wallpaper library into the settings panel as a compact list of
 * tag chips (name only; description in the hover tooltip). Two views:
 *   - Local: this device's cache (local ST backgrounds + synced remote ones).
 *   - Global: the whole shared community library, fetched live from the worker.
 * Clicking a chip applies that wallpaper to the background; global picks are
 * also added to the local cache so the scene analyzer can reuse them. Own
 * global uploads get a delete affordance.
 */
async function renderLibrary() {
    const settings = getSettings();
    const view = settings.libraryView === 'global' ? 'global' : 'local';
    const container = $('#stv_library');
    if (!container.length) return;

    // Keep the Local/Global tabs in sync with the active view.
    $('#stv_view_local, #stv_view_global').removeClass('active');
    $(view === 'global' ? '#stv_view_global' : '#stv_view_local').addClass('active');

    let items;
    if (view === 'global') {
        container.html('<small><i class="fa-solid fa-spinner fa-spin"></i> Loading global library…</small>');
        const remote = await fetchGlobalLibrary(settings);
        if (remote === null) {
            container.html('<small>Could not reach the global library.</small>');
            return;
        }
        items = remote;
    } else {
        items = getCache();
    }

    const templateItems = items.map(e => ({
        name: e.name,
        description: e.description || '',
        filename: e.filename || '',
        url: e.url || '',
        thumb: e.thumb || '',
        id: e.id || '',
        deletable: !!(view === 'global' && e.own && e.id),
    }));
    const html = await renderExtensionTemplateAsync('third-party/SillyTavern-Visualize', 'library', { items: templateItems });
    container.html(html);

    // Click a tag → apply the wallpaper (and remember global picks locally).
    container.find('.visualize-chip').on('click', async function (e) {
        if ($(e.target).closest('.visualize-delete').length) return; // delete button handles itself
        const entry = {
            name: $(this).data('name'),
            description: $(this).data('description') || '',
            filename: $(this).data('filename') || '',
            url: $(this).data('url') || '',
            thumb: $(this).data('thumb') || '',
            id: $(this).data('id') ? String($(this).data('id')) : '',
        };
        if (!entry.filename && !entry.url) return;
        // Global picks join the local cache so the scene analyzer can reuse them.
        if (entry.url) {
            const cache = getCache();
            if (!cache.some(c => (entry.id && c.id === entry.id) || (entry.url && c.url === entry.url))) {
                cache.push({ ...entry, own: true });
                saveSettingsDebounced();
            }
        }
        await applyBackground(entry);
    });

    // Delete affordance for own public-library uploads.
    container.find('.visualize-delete').on('click', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const id = $(this).data('id');
        if (!id) return;
        try {
            await deleteRemoteWallpaper(getSettings(), id);
            const cache = getCache();
            const idx = cache.findIndex(x => String(x.id) === String(id));
            if (idx !== -1) cache.splice(idx, 1);
            saveSettingsDebounced();
            renderLibrary();
        } catch (err) {
            console.warn('[visualize] delete failed', err?.message);
        }
    });
}

async function fillVendorSelect() {
    const catalog = await fetchModelCatalog();
    const select = $('#stv_text_provider');
    if (!select.length) return;
    select.empty();
    for (const vendor of catalog.vendors) {
        select.append(`<option value="${vendor}">${vendor}</option>`);
    }
    select.val(getSettings().textVendor);
}

async function fillTextModelSelect(vendor) {
    const catalog = await fetchModelCatalog();
    const select = $('#stv_text_model');
    if (!select.length) return;
    const models = catalog.models.filter(m => m.id.startsWith(`${vendor}/`));
    select.empty();
    for (const m of models) {
        select.append(`<option value="${m.id}">${m.id}</option>`);
    }
    const current = getSettings().textModel;
    // Only keep a saved out-of-catalog model when it actually belongs to this vendor.
    if (current.startsWith(`${vendor}/`)) {
        ensureModelOption(select[0], current);
        select.val(current);
    } else {
        // Select the first model of the vendor (the change handler will persist it).
        select[0].selectedIndex = 0;
    }
}

async function fillImageModelSelect() {
    const catalog = await fetchModelCatalog();
    const select = $('#stv_image_model');
    if (!select.length) return;
    select.empty();
    for (const m of catalog.imageModels) {
        const price = Number.isFinite(m.imagePrice) ? ` — ${formatImagePrice(m.imagePrice)}` : '';
        select.append(`<option value="${m.id}">${m.id}${price}</option>`);
    }
    // No special-cased "(saved)" entries in the ordering: if the current model is
    // in the filtered list keep it; otherwise select the cheapest and persist it.
    const current = getSettings().imageModel;
    if (current && catalog.imageModels.some(m => m.id === current)) {
        select.val(current);
    } else {
        select[0].selectedIndex = 0;
        getSettings().imageModel = select.val();
        saveSettingsDebounced();
    }
}

/**
 * Reflects the model-catalog load state in the settings panel:
 * loading (spinner), loaded (hidden — no persistent count line), or failed
 * (with a retry link).
 */
function setModelStatus(state) {
    const el = $('#stv_model_status');
    if (!el.length) return;
    if (state === 'loading') {
        el.show().html('<i class="fa-solid fa-spinner fa-spin"></i> Loading model list…');
        el.removeClass('stv-model-error');
    } else if (state === 'loaded') {
        el.hide();
        el.removeClass('stv-model-error');
    } else {
        el.show().html('<i class="fa-solid fa-triangle-exclamation"></i> Couldn\'t load models — <a href="#" id="stv_model_retry">retry</a>');
        el.addClass('stv-model-error');
    }
}

async function renderSettingsPanel() {
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync('third-party/SillyTavern-Visualize', 'settings', {
        imageKey: settings.imageKey,
        imageModel: settings.imageModel,
        textVendor: settings.textVendor,
        textModel: settings.textModel,
        sharePublic: settings.sharePublic,
        wallpaperEnabled: settings.wallpaperEnabled,
        messagesBetweenUpdates: settings.messagesBetweenUpdates,
        remainingTurns: Math.max(0, Math.max(1, settings.messagesBetweenUpdates) - messageCount),
    });
    $('#extensions_settings2').append(html);

    updateStatusUI();
    initTooltips();

    $('#stv_image_key').on('input', () => { getSettings().imageKey = $('#stv_image_key').val(); saveSettingsDebounced(); });
    $('#stv_image_model').on('change', () => { getSettings().imageModel = $('#stv_image_model').val(); saveSettingsDebounced(); });
    $('#stv_text_provider').on('change', async function () {
        const vendor = $(this).val();
        getSettings().textVendor = vendor;
        saveSettingsDebounced();
        await fillTextModelSelect(vendor);
        // Keep the previously chosen model if it's from this vendor; otherwise adopt
        // the first model in the new vendor's list.
        const current = getSettings().textModel;
        if (!current.startsWith(`${vendor}/`)) {
            getSettings().textModel = $('#stv_text_model').val();
            saveSettingsDebounced();
        }
        fillInferenceProviderSelect(getSettings().textModel);
    });
    $('#stv_text_model').on('change', function () {
        getSettings().textModel = $(this).val();
        saveSettingsDebounced();
        fillInferenceProviderSelect($(this).val());
    });
    $('#stv_inference_provider').on('change', () => { getSettings().inferenceProvider = $('#stv_inference_provider').val(); saveSettingsDebounced(); });
    $('#stv_share_public').on('change', () => { getSettings().sharePublic = $('#stv_share_public').is(':checked'); saveSettingsDebounced(); });
    $('#stv_wallpaper_enabled').on('change', () => { getSettings().wallpaperEnabled = $('#stv_wallpaper_enabled').is(':checked'); saveSettingsDebounced(); });
    $('#stv_messages_between').on('input', () => {
        const value = parseInt($('#stv_messages_between').val(), 10);
        getSettings().messagesBetweenUpdates = Number.isFinite(value) && value > 0 ? value : 2;
        const label = $('#stv_messages_between_value');
        if (label.length) label.text(String(getSettings().messagesBetweenUpdates));
        saveSettingsDebounced();
        updateStatusUI();
    });
    $('#stv_update_now').on('click', () => updateWallpaper());
    $('#stv_clear_cache').on('click', () => {
        getSettings().wallpaperCache = [];
        saveSettingsDebounced();
        renderLibrary();
    });

    // Local vs Global library view.
    $('#stv_view_local').on('click', () => {
        getSettings().libraryView = 'local';
        saveSettingsDebounced();
        renderLibrary();
    });
    $('#stv_view_global').on('click', () => {
        getSettings().libraryView = 'global';
        saveSettingsDebounced();
        renderLibrary();
    });

    // Populate the model selects from OpenRouter's catalog (graceful if offline).
    const populate = async () => {
        setModelStatus('loading');
        try {
            await fetchModelCatalog();
            await fillVendorSelect();
            await fillTextModelSelect(getSettings().textVendor);
            await fillInferenceProviderSelect(getSettings().textModel);
            await fillImageModelSelect();
            setModelStatus('loaded');
        } catch (err) {
            console.warn('[visualize] could not load OpenRouter model catalog', err);
            setModelStatus('error');
        }
    };
    await populate();
    $('#stv_model_retry').on('click', (e) => {
        e.preventDefault();
        modelCatalog = null; // force refetch
        populate();
    });

    // Pull wallpapers from the shared library (from any device) into the local cache.
    await syncRemoteCache(getSettings());
    await renderLibrary();
}

/**
 * Injects a single #stv-tooltip div into <body> and wires hover/focus events on
 * .stv-info elements inside the settings panel. position:fixed escapes ST's
 * overflow:hidden extensions panel so the tooltip is never clipped.
 */
function initTooltips() {
    document.getElementById('stv-tooltip')?.remove();
    const tooltip = document.createElement('div');
    tooltip.id = 'stv-tooltip';
    document.body.appendChild(tooltip);

    const panel = document.getElementById('stv_settings');
    if (!panel) return;

    panel.addEventListener('mouseover', (e) => {
        const target = e.target.closest('.stv-info');
        if (!target?.dataset.tooltip) return;
        tooltip.textContent = target.dataset.tooltip;
        const rect = target.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const tooltipWidth = tooltip.offsetWidth || 260;
        tooltip.style.left = `${Math.min(rect.left, window.innerWidth - tooltipWidth - 8)}px`;
        tooltip.style.top = spaceBelow > 80
            ? `${rect.bottom + 6}px`
            : `${rect.top - tooltip.offsetHeight - 6}px`;
        tooltip.classList.add('stv-tooltip-visible');
    });

    panel.addEventListener('mouseout', (e) => {
        if (e.target.closest('.stv-info')) {
            tooltip.classList.remove('stv-tooltip-visible');
        }
    });
}

export function init() {
    const buttonHtml = `
        <div id="stv_recap" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
            <span>Visualize</span>
            <span id="stv_recap_count" class="cr-count-badge"></span>
        </div>
    `;
    $('#extensionsMenu').append(buttonHtml);
    $('#stv_recap').on('click', () => updateWallpaper());

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wallpaper',
        callback: () => updateWallpaper(),
        returns: 'string',
        helpString: 'Analyzes the current scene and sets a matching background wallpaper.',
    }));

    const ctx = getContext();
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENT, onMessageSent);

    renderSettingsPanel();
    console.debug('[visualize] extension initialized');
}
