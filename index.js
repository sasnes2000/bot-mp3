// Telegram-бот: YouTube-ссылка → аудиофайл.
// InnerTube + signatureCipher deciphering + cobalt fallback.

const URL_RE =
  /(https?:\/\/(?:www\.|m.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+)/i;

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Клиенты БЕЗ cookie — они возвращают прямые ссылки
const RAW_CLIENTS = [
  { name: 'ANDROID', ver: '20.10.38', sdk: 30, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
  { name: 'ANDROID_MUSIC', ver: '7.27.52', sdk: 30, ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip' },
  { name: 'TVHTML5', ver: '7.20241201.14.00', screen: 'EMBED', ua: 'Mozilla/5.0 (PlayStation; PlayStation 4/5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15' },
  { name: 'IOS', ver: '20.10.4', sdk: null, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)' },
];

// Клиенты С cookie (WEB) — нужен deciphering
const WEB_CLIENTS = [
  { name: 'WEB', ver: '2.20250101.00.00', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0' },
  { name: 'WEB_EMBEDDED_PLAYER', ver: '1.20250101.00.00', screen: 'EMBED', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0' },
];

const tg = (env, method, payload) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

const edit = (env, chatId, messageId, text) =>
  tg(env, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text,
    disable_web_page_preview: true,
  }).catch(() => {});

const videoId = (url) => (url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/) || [])[1] || null;
const short = (err) => String(err?.message || err).slice(0, 80);

// ── Cookie auth для WEB клиентов ────────────────────────────────────────────

async function authHeaders(env, base) {
  if (!env.YT_COOKIE) return base;
  const cookie = env.YT_COOKIE;
  const headers = { ...base, Cookie: cookie };
  const val = (k) => cookie.match(new RegExp(`(?:^|; )${k}=([^;]+)`))?.[1];
  const origin = 'https://www.youtube.com';
  const ts = Math.floor(Date.now() / 1000);
  const sha1 = async (s) => {
    const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const parts = [];
  for (const [name, label] of [
    ['SAPISID', 'SAPISIDHASH'],
    ['__Secure-1PAPISID', 'SAPISID1PHASH'],
    ['__Secure-3PAPISID', 'SAPISID3PHASH'],
  ]) {
    const v = val(name);
    if (v) parts.push(`${label} ${ts}_${await sha1(`${ts} ${v} ${origin}`)}`);
  }
  if (parts.length) headers.Authorization = parts.join(' ');
  if (val('__Secure-3PAPISID') || val('SAPISID')) headers['X-Origin'] = origin;
  return headers;
}

// ── Signature deciphering для WEB клиентов ──────────────────────────────────

let _decipherCache = null;

async function getDecipherFn(env) {
  if (_decipherCache) return _decipherCache;
  if (!env.YT_COOKIE) return null;
  try {
    const pageRes = await fetch('https://www.youtube.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0', Cookie: env.YT_COOKIE },
    });
    const html = await pageRes.text();
    const playerUrlMatch = html.match(/"(https?:\/\/www\.youtube\.com\/s\/player\/[^"]+\/player_ias\.vflset\/en_US\/base\.js)"/);
    if (!playerUrlMatch) return null;
    const jsRes = await fetch(playerUrlMatch[1]);
    const js = await jsRes.text();

    // Найти функцию decipher
    const fnName = js.match(/b=a\.get\("signature"\)\)a=a\.split\(""\);(.*?)\(/)?.[1]
      || js.match(/var \w+=\w+\.split\(""\),(\w+)=\[/)?.[1]
      || js.match(/(\w+)\s*=\s*function\(\s*\w+\s*\)\s*\{\s*\w+\.reverse\(\)/)?.[1];
    if (!fnName) return null;

    const fnBody = js.match(new RegExp(`function\\s+${fnName}\\s*\\(\\s*\\w+\\s*\\)\\s*\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}`));
    const fnBody2 = js.match(new RegExp(`var\\s+${fnName}\\s*=\\s*function\\s*\\(\\s*\\w+\\s*\\)\\s*\\{([\\s\\S]*?)\\}\\s*;`));

    const helperName = js.match(new RegExp(`function\\s+${fnName}\\s*\\([\\s\\S]*?\\)\\s*\\{[\\s\\S]*?\\b(\\w+)\\.\\w+`))?.[1]
      || js.match(new RegExp(`var\\s+${fnName}\\s*=[\\s\\S]*?\\b(\\w+)\\.\\w+`))?.[1];

    let helperBody = '';
    if (helperName) {
      const hMatch = js.match(new RegExp(`var\\s+${helperName}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*;`));
      if (hMatch) helperBody = `var ${helperName}={${hMatch[1]}};`;
    }

    const body = (fnBody?.[1] || fnBody2?.[1] || '').trim();
    const code = `
      ${helperBody}
      var ${fnName} = function(a) {
        a = a.split("");
        ${body}
        return a.join("");
      };
      return ${fnName};
    `;
    _decipherCache = new Function(code)();
    return _decipherCache;
  } catch {
    return null;
  }
}

function decodeSig(signatureCipher, decipherFn) {
  if (!signatureCipher || !decipherFn) return null;
  const params = new URLSearchParams(signatureCipher);
  const s = params.get('s');
  const sp = params.get('sp') || 'sig';
  const base = params.get('url');
  if (!s || !base) return null;
  try {
    const sig = decipherFn(s);
    return `${base}&${sp}=${encodeURIComponent(sig)}`;
  } catch {
    return null;
  }
}

// ── 1. InnerTube (прямые клиенты — без cookie, без deciphering) ──────────────

async function fromYouTubeRaw(env, vidId, errors) {
  for (const c of RAW_CLIENTS) {
    const client = { clientName: c.name, clientVersion: c.ver, hl: 'en', gl: 'US' };
    if (c.sdk) client.androidSdkVersion = c.sdk;
    if (c.screen) client.clientScreen = c.screen;

    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
          body: JSON.stringify({ context: { client }, videoId: vidId, contentCheckOk: true, racyCheckOk: true }),
        }
      );
      const data = await res.json().catch(() => ({}));
      const status = data?.playabilityStatus?.status;
      if (status && status !== 'OK') { errors.push(`${c.name}: ${status}`); continue; }

      const formats = [...(data?.streamingData?.adaptiveFormats || []), ...(data?.streamingData?.formats || [])];
      const audio = formats
        .filter((f) => (f.mimeType || '').startsWith('audio') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (!audio) { errors.push(`${c.name}: нет прямой ссылки`); continue; }

      const file = await download(audio.url, c.ua);
      if (file) {
        const m4a = /mp4/.test(audio.mimeType || '');
        const title = data?.videoDetails?.title || 'audio';
        return { ...file, filename: `${title}.${m4a ? 'm4a' : 'webm'}`, mime: m4a ? 'audio/mp4' : 'audio/webm' };
      }
      errors.push(`${c.name}: файл пустой`);
    } catch (err) {
      errors.push(`${c.name}: ${short(err)}`);
    }
  }
  return null;
}

// ── 2. InnerTube (WEB клиенты с cookie + deciphering) ───────────────────────

async function fromYouTubeWeb(env, vidId, errors) {
  if (!env.YT_COOKIE) return null;
  const decipherFn = await getDecipherFn(env);

  for (const c of WEB_CLIENTS) {
    const client = { clientName: c.name, clientVersion: c.ver, hl: 'en', gl: 'US' };
    if (c.screen) client.clientScreen = c.screen;

    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
          method: 'POST',
          headers: await authHeaders(env, { 'Content-Type': 'application/json', 'User-Agent': c.ua }),
          body: JSON.stringify({ context: { client }, videoId: vidId, contentCheckOk: true, racyCheckOk: true }),
        }
      );
      const data = await res.json().catch(() => ({}));
      const status = data?.playabilityStatus?.status;
      if (status && status !== 'OK') { errors.push(`${c.name}: ${status}`); continue; }

      const formats = [...(data?.streamingData?.adaptiveFormats || []), ...(data?.streamingData?.formats || [])];
      const audio = formats
        .filter((f) => (f.mimeType || '').startsWith('audio') && (f.url || f.signatureCipher))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (!audio) { errors.push(`${c.name}: нет форматов`); continue; }

      let url = audio.url;
      if (!url && audio.signatureCipher) {
        if (!decipherFn) { errors.push(`${c.name}: нужен deciphering, но не удалось`); continue; }
        url = decodeSig(audio.signatureCipher, decipherFn);
        if (!url) { errors.push(`${c.name}: ошибка deciphering`); continue; }
      }
      if (!url) { errors.push(`${c.name}: нет URL`); continue; }

      const file = await download(url, c.ua);
      if (file) {
        const m4a = /mp4/.test(audio.mimeType || '');
        const title = data?.videoDetails?.title || 'audio';
        return { ...file, filename: `${title}.${m4a ? 'm4a' : 'webm'}`, mime: m4a ? 'audio/mp4' : 'audio/webm' };
      }
      errors.push(`${c.name}: файл пустой`);
    } catch (err) {
      errors.push(`${c.name}: ${short(err)}`);
    }
  }
  return null;
}

// ── 3. Свой cobalt (если задан COBALT_API) ───────────────────────────────────

async function fromCobalt(env, ytUrl, errors) {
  const api = (env.COBALT_API || '').trim();
  if (!api) return null;

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (env.COBALT_KEY) headers.Authorization = `Api-Key ${env.COBALT_KEY}`;

  try {
    const res = await fetch(api, {
      method: 'POST', headers,
      body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3' }),
    });
    const data = await res.json().catch(() => ({}));
    const link = data.url || data.picker?.[0]?.url;
    if (!link) { errors.push(`cobalt: ${data.error?.code || data.text || res.status}`); return null; }
    const file = await download(link, 'Mozilla/5.0');
    if (!file) { errors.push('cobalt: файл пустой'); return null; }
    return { ...file, filename: data.filename || 'audio.mp3', mime: 'audio/mpeg' };
  } catch (err) {
    errors.push(`cobalt: ${short(err)}`);
    return null;
  }
}

// ── Общее ────────────────────────────────────────────────────────────────────

async function download(url, ua = 'Mozilla/5.0', minBytes = 10000) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': ua,
      'Range': 'bytes=0-',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    },
  });
  const buf = await res.arrayBuffer();
  if (buf.byteLength < minBytes) return null;
  // Проверяем что это не HTML-страница с ошибкой
  const preview = new TextDecoder().decode(new Uint8Array(buf).slice(0, 200));
  if (/<!DOCTYPE|<html|<head/i.test(preview)) return null;
  return { buf };
}

async function getAudio(env, ytUrl) {
  const errors = [];
  const vid = videoId(ytUrl);

  const result =
    (vid && (await fromYouTubeRaw(env, vid, errors))) ||
    (vid && (await fromYouTubeWeb(env, vid, errors))) ||
    (await fromCobalt(env, ytUrl, errors));

  if (result) return result;
  throw new Error(errors.join(' • ') || 'не удалось получить аудио');
}

async function sendAudio(env, chatId, buf, title, mime) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('title', title);
  form.append('performer', 'YouTube');
  form.append('audio', new Blob([buf], { type: mime }), `${title}.m4a`);

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendAudio`, {
    method: 'POST', body: form,
  });
  return res.json();
}

async function handleUpdate(update, env) {
  const message = update.message || update.channel_post;
  const text = message?.text || '';
  const chatId = message?.chat?.id;
  if (!chatId) return;

  const match = text.match(URL_RE);
  if (!match) {
    const hello = /^\/(start|help)/.test(text.trim());
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: hello
        ? 'Привет! 👋\nКинь ссылку на видео YouTube — пришлю аудио 🎵'
        : 'Пришли ссылку на видео YouTube — пришлю аудио 🎵',
    });
    return;
  }

  const status = await tg(env, 'sendMessage', { chat_id: chatId, text: '⏳ Готовлю аудио...' });
  const statusId = status?.result?.message_id;

  try {
    const { buf, filename, mime } = await getAudio(env, match[1]);
    if (statusId) await edit(env, chatId, statusId, '📤 Отправляю файл...');

    const sent = await sendAudio(env, chatId, buf, filename.replace(/\.[a-z0-9]+$/i, ''), mime);
    if (!sent.ok) {
      throw new Error(
        /too big/i.test(sent.description || '')
          ? 'файл больше 50 MB — лимит Telegram'
          : sent.description || 'Telegram не принял файл'
      );
    }

    if (statusId) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: statusId });
  } catch (err) {
    const msg = `❌ Не получилось: ${short(err)}`;
    if (statusId) await edit(env, chatId, statusId, msg);
    else await tg(env, 'sendMessage', { chat_id: chatId, text: msg });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (
        env.WEBHOOK_SECRET &&
        request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET
      ) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok');
    }

    return new Response('ytg-bot is running', { status: 200 });
  },
};
