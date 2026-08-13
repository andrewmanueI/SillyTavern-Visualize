// Auto-Wallpaper: automatically keeps the background wallpaper in sync with the
// current roleplay scene.
//
// Every N messages (default 2) it analyzes the latest exchange with the text
// model, extracts a people-free setting description + clear name, then either
// reuses a matching cached wallpaper or generates a new one via an OpenRouter
// image model (default krea/krea-2-medium-turbo).
//
// Only the latest exchange is sent to the text model, keeping input/output low.

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

function transcriptOf(ctx, messages) {
    const who = (m) => (m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Assistant'));
    return messages.map(m => `${who(m)}: ${String(m.mes).trim()}`).join('\n');
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

async function extractSetting(transcript, settings) {
    const raw = await chatCompletion([
        {
            role: 'system',
            content: 'You describe the physical SETTING of a story scene only. Reply with JSON with exactly two keys: "name" (a short kebab-case slug, 2-4 words, describing the scene) and "description" (1-2 sentences: location, time, weather, lighting, era, objects). NEVER mention people, characters, names, pronouns, creatures, or actions.',
        },
        { role: 'user', content: transcript },
    ], settings, 220);

    try {
        const j = extractJson(raw);
        const name = String(j.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const description = String(j.description || '').trim();
        if (name && description) return { name, description };
    } catch { /* fall through to fallback */ }

    return { name: `scene-${Date.now()}`, description: raw || 'A generic atmospheric scene.' };
}

async function matchCachedWallpaper(transcript, cache, settings) {
    if (!cache.length) return null;

    const list = cache.map(e => `- name: ${e.name} — ${e.description}`).join('\n');
    const raw = await chatCompletion([
        {
            role: 'system',
            content: 'You match a roleplay scene to cached background wallpapers. Output ONLY the exact name of the best-matching cached wallpaper, or exactly "NONE" if none match well. Use a cached name verbatim — never invent one.',
        },
        { role: 'user', content: `Scene:\n${transcript}\n\nCached wallpapers:\n${list}` },
    ], settings, 40);

    const pick = raw.trim().toLowerCase()
        .replace(/^```[a-zA-Z]*\s*/, '')
        .replace(/\s*```\s*$/, '')
        .replace(/["'`]/g, '')
        .trim();
    if (!pick || pick === 'none' || pick.startsWith('none')) return null;

    return cache.find(e =>
        e.name.toLowerCase() === pick
        || pick.includes(e.name.toLowerCase())
        || e.name.toLowerCase().includes(pick),
    ) || null;
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

function applyBackground(filename) {
    const url = `url("backgrounds/${encodeURIComponent(filename)}")`;
    // ST persists/applies the background through `background_settings` (the object
    // saved under the top-level "background" key and reloaded by loadBackgroundSettings),
    // so mutate it directly — writing to power_user.background is not read back.
    setFitting(getSettings().fitMode);
    background_settings.name = filename;
    background_settings.url = url;
    $('#bg1').css('background-image', url);
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

    applyBackground(savedName);
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
    const transcript = transcriptOf(ctx, recent);

    isUpdating = true;
    try {
        const cache = getCache();
        const entry = await matchCachedWallpaper(transcript, cache, settings);
        if (entry) {
            applyBackground(entry.filename);
            return;
        }
        const setting = await extractSetting(transcript, settings);
        const result = await generateWallpaper(setting, settings);
        if (!cache.some(e => e.name === result.name)) {
            cache.push(result);
            saveSettingsDebounced();
            await renderLibrary();
        }
    } catch (err) {
        console.error('[auto-wallpaper] failed', err);
    } finally {
        isUpdating = false;
    }
}

function onMessageSent() {
    const settings = getSettings();
    if (!settings.wallpaperEnabled) return;
    messageCount += 1;
    if (messageCount >= Math.max(1, settings.messagesBetweenUpdates)) {
        messageCount = 0;
        updateWallpaper();
    }
}

function onMessageReceived(messageId, type) {
    // Skip the character's greeting / first-message emissions.
    if (type === 'first_message') return;
    onMessageSent();
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
    });
    $('#extensions_settings2').append(html);

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
