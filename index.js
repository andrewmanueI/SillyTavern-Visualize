// Auto-Wallpaper: automatically keeps the background wallpaper in sync with the
// current roleplay scene.
//
// Every N completed assistant replies (default 2) it sends the latest exchange to
// the text model in a single call as a structured message array: a developer
// message (with <tags>-delimited sections carrying the full cached-wallpaper
// inventory, output format, and rules) + the conversation as user/assistant turns
// + a final task. The model either picks a matching cached wallpaper (reuse) or
// proposes a new people-free setting (generate). New wallpapers are produced via
// an OpenRouter image model (default krea/krea-2-medium-turbo).
//
// Counting starts only after the assistant finishes a turn: the user's own send
// doesn't advance the counter.

import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, getThumbnailUrl } from '../../../../script.js';
import { background_settings } from '../../../backgrounds.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const MODULE_NAME = 'auto_wallpaper';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const defaultSettings = Object.freeze({
    imageKey: '',
    imageModel: 'krea/krea-2-medium-turbo',
    aspectRatio: '9:16',
    cropRatio: '1:4',
    fitMode: 'cover',
    textModel: 'google/gemma-4-26b-a4b-it',
    wallpaperEnabled: true,
    messagesBetweenUpdates: 2,
    wallpaperCache: [],
});

let messageCount = 0;
let isUpdating = false;

const FADE_LAYER_ID = 'cr_bg_fade';
const FADE_MS = 700;

function getSettings() {
    const { extensionSettings } = getContext();
    // Migrate settings from the old 'chat_recap' key (folder was renamed to auto-wallpaper).
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
    return extensionSettings[MODULE_NAME];
}

function getCache() {
    const cache = getSettings().wallpaperCache;
    return Array.isArray(cache) ? cache : [];
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

async function chatCompletion(messages, settings, maxTokens = 200) {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.imageKey}`,
        },
        body: JSON.stringify({ model: settings.textModel, messages, max_tokens: maxTokens }),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error?.message || `text API ${res.status}`);
    }
    return data.choices?.[0]?.message?.content?.trim() ?? '';
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
 * `messages` are the recent ST chat message objects; they become the structured
 * user/assistant turns of the request.
 *
 * Returns { mode: 'reuse', entry } or { mode: 'generate', setting }.
 */
async function decideWallpaper(messages, cache, settings) {
    const raw = await chatCompletion(buildDecideMessages(messages, cache), settings, 220);

    let parsed = null;
    try {
        parsed = extractJson(raw);
    } catch { /* fall through to fallback */ }

    // REUSE: model picked a cached name (possibly humanized — normalize it to the
    // same kebab-slug shape the generate names use before matching).
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
        if (entry) return { mode: 'reuse', entry };
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

    // Fallback: unparseable response — generate a generic scene.
    return { mode: 'generate', setting: { name: `scene-${Date.now()}`, description: raw || 'A generic atmospheric scene.' } };
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
// (#cr_bg_fade) that sits exactly over #bg1, fade the clone in over the old image,
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

function preloadImage(filename) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve(); // never block application on a preload failure
        img.src = `backgrounds/${encodeURIComponent(filename)}`;
    });
}

async function transitionTo(filename, url) {
    await preloadImage(filename);

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

async function applyBackground(filename) {
    const url = `url("backgrounds/${encodeURIComponent(filename)}")`;
    // ST persists/applies the background through `background_settings` (the object
    // saved under the top-level "background" key and reloaded by loadBackgroundSettings),
    // so mutate it directly — writing to power_user.background is not read back.
    setFitting(getSettings().fitMode);
    background_settings.name = filename;
    background_settings.url = url;
    await transitionTo(filename, url);
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
    const filename = `auto-wallpaper-${setting.name}.${extensionForMediaType(mediaType)}`;

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

    await applyBackground(savedName);
    return { name: setting.name, description: setting.description, filename: savedName };
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
        console.warn('[auto-wallpaper] no OpenRouter API key set');
        return;
    }

    const messages = (ctx.chat || []).filter(m => m && m.mes && !m.is_system);
    if (!messages.length) return;

    const recent = messages.slice(-Math.max(2, settings.messagesBetweenUpdates));

    isUpdating = true;
    setLoading(true, 'Analyzing scene…');
    try {
        const cache = getCache();
        const decision = await decideWallpaper(recent, cache, settings);
        if (decision.mode === 'reuse') {
            await applyBackground(decision.entry.filename);
            return;
        }
        setLoading(true, 'Generating wallpaper…');
        const result = await generateWallpaper(decision.setting, settings);
        if (!cache.some(e => e.name === result.name)) {
            cache.push(result);
            saveSettingsDebounced();
            await renderLibrary();
        }
    } catch (err) {
        console.error('[auto-wallpaper] failed', err);
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
 * auto-wallpaper on/off state in the settings panel and the wand-menu badge.
 */
function updateStatusUI() {
    const settings = getSettings();
    const enabled = settings.wallpaperEnabled;
    const total = Math.max(1, settings.messagesBetweenUpdates);
    const remaining = Math.max(0, total - messageCount);
    const badge = $('#cr_recap_count');
    const turns = $('#cr_turns_left');
    if (badge.length) {
        badge.text(enabled ? String(remaining) : '');
        badge.toggleClass('cr-count-hidden', !enabled);
    }
    if (turns.length) turns.text(enabled ? String(remaining) : '—');
}

/**
 * Shows/hides the in-panel loading indicator (spinner + stage text) and spins the
 * wand-menu icon while a wallpaper update is in progress.
 */
function setLoading(active, text) {
    const spinner = $('#cr_status_loading');
    const turnsRow = $('#cr_status_turns');
    const icon = $('#cr_recap .extensionsMenuExtensionButton');
    if (active) {
        if (spinner.length) {
            spinner.css('display', '');
            if (text && $('#cr_status_loading_text').length) {
                $('#cr_status_loading_text').text(text);
            }
        }
        if (turnsRow.length) turnsRow.css('display', 'none');
        if (icon.length) icon.addClass('fa-spin');
    } else {
        if (spinner.length) spinner.css('display', 'none');
        if (turnsRow.length) turnsRow.css('display', '');
        if (icon.length) icon.removeClass('fa-spin');
        updateStatusUI();
    }
}

/**
 * Renders the cached wallpaper library (thumbnails + tags) into the settings panel.
 */
async function renderLibrary() {
    const cache = getCache();
    const items = cache.map(e => ({
        name: e.name,
        description: e.description || '',
        thumbnail: getThumbnailUrl('bg', e.filename),
    }));
    const html = await renderExtensionTemplateAsync('third-party/SillyTavern-AutoWallpaper', 'library', { items });
    const container = $('#cr_library');
    if (container.length) container.html(html);
}

async function renderSettingsPanel() {
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync('third-party/SillyTavern-AutoWallpaper', 'settings', {
        imageKey: settings.imageKey,
        imageModel: settings.imageModel,
        aspectRatio: settings.aspectRatio,
        cropRatio: settings.cropRatio,
        fitMode: settings.fitMode,
        textModel: settings.textModel,
        wallpaperEnabled: settings.wallpaperEnabled,
        messagesBetweenUpdates: settings.messagesBetweenUpdates,
        remainingTurns: Math.max(0, Math.max(1, settings.messagesBetweenUpdates) - messageCount),
    });
    $('#extensions_settings2').append(html);
    updateStatusUI();

    $('#cr_image_key').on('input', () => { getSettings().imageKey = $('#cr_image_key').val(); saveSettingsDebounced(); });
    $('#cr_image_model').on('input', () => { getSettings().imageModel = $('#cr_image_model').val(); saveSettingsDebounced(); });
    $('#cr_aspect_ratio').on('input', () => { getSettings().aspectRatio = $('#cr_aspect_ratio').val(); saveSettingsDebounced(); });
    $('#cr_crop_ratio').on('input', () => { getSettings().cropRatio = $('#cr_crop_ratio').val(); saveSettingsDebounced(); });
    $('#cr_fit_mode').on('input', () => { getSettings().fitMode = $('#cr_fit_mode').val(); saveSettingsDebounced(); });
    $('#cr_text_model').on('input', () => { getSettings().textModel = $('#cr_text_model').val(); saveSettingsDebounced(); });
    $('#cr_wallpaper_enabled').on('change', () => { getSettings().wallpaperEnabled = $('#cr_wallpaper_enabled').is(':checked'); saveSettingsDebounced(); });
    $('#cr_messages_between').on('input', () => {
        const value = parseInt($('#cr_messages_between').val(), 10);
        getSettings().messagesBetweenUpdates = Number.isFinite(value) && value > 0 ? value : 2;
        saveSettingsDebounced();
        updateStatusUI();
    });
    $('#cr_update_now').on('click', () => updateWallpaper());
    $('#cr_clear_cache').on('click', () => {
        getSettings().wallpaperCache = [];
        saveSettingsDebounced();
        renderLibrary();
    });

    await renderLibrary();
}

export function init() {
    const buttonHtml = `
        <div id="cr_recap" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
            <span>Auto Wallpaper</span>
            <span id="cr_recap_count" class="cr-count-badge"></span>
        </div>
    `;
    $('#extensionsMenu').append(buttonHtml);
    $('#cr_recap').on('click', () => updateWallpaper());

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wallpaper',
        callback: () => updateWallpaper(),
        returns: 'string',
        helpString: 'Analyzes the current scene and sets a matching (cached, people-free) background wallpaper.',
    }));

    const ctx = getContext();
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENT, onMessageSent);

    renderSettingsPanel();
    console.debug('[auto-wallpaper] extension initialized');
}
