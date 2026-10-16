// Telegram-бот: YouTube-ссылка → аудиофайл.
// 1. Скрапинг страницы видео (ytInitialPlayerResponse) с куками + deciphering
// 2. InnerTube (RAW клиенты без cookie)
// 3. InnerTube (WEB клиенты с cookie + deciphering)
// 4. Cobalt fallback

const URL_RE =
  /(https?:\/\/(?:www\.|m.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+)/i;

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

const RAW_CLIENTS = [
  { name: 'ANDROID', ver: '20.10.38', sdk: 30, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
  { name: 'ANDROID_MUSIC', ver: '7.27.52', sdk: 30, ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip' },
  { name: 'TVHTML5', ver: '7.20241201.14.00', screen: 'EMBED', ua: 'Mozilla/5.0 (PlayStation; PlayStation 4/5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15' },
  { name: 'IOS', ver: '20.10.4', sdk: null, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)' },
];

const WEB_CLIENTS = [
  { name: 'WEB', ver: '2.20250101.00.00', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { name: 'WEB_EMBEDDED_PLAYER', ver: '1.20250101.00.00', screen: 'EMBED', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
];

const tg = (env, method, payload) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

const edit = (env, chatId, messageId, text) =>
  tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }).catch(() => {});

const videoId = (url) => (url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/) || [])[1] || null;
const short = (err) => String(err?.message || err).slice(0, 150);

// ── Извлечение JSON со сбалансированными скобками ───────────────────────────

function extractJsonAt(text, marker) {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const braceStart = text.indexOf('{', idx + marker.length);
  if (braceStart === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(braceStart, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ── Cookie auth ─────────────────────────────────────────────────────────────

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
  for (const [name, label] of [['SAPISID', 'SAPISIDHASH'], ['__Secure-1PAPISID', 'SAPISID1PHASH'], ['__Secure-3PAPISID', 'SAPISID3PHASH']]) {
    const v = val(name);
    if (v) parts.push(`${label} ${ts}_${await sha1(`${ts} ${v} ${origin}`)}`);
  }
  if (parts.length) headers.Authorization = parts.join(' ');
  if (val('__Secure-3PAPISID') || val('SAPISID')) headers['X-Origin'] = origin;
  return headers;
}

// ── Deciphering ─────────────────────────────────────────────────────────────

let _decipherFn = null;

async function getDecipher(env) {
  if (_decipherFn) return _decipherFn;
  if (!env.YT_COOKIE) return null;
  try {
    const pageRes = await fetch('https://www.youtube.com/', {
      headers: { 'User-Agent': WEB_CLIENTS[0].ua, Cookie: env.YT_COOKIE },
    });
    const html = await pageRes.text();
    const playerUrlMatch = html.match(/"(https?:\/\/www\.youtube\.com\/s\/player\/[^"]+\/player_ias\.vflset\/en_US\/base\.js)"/);
    if (!playerUrlMatch) return null;
    const jsRes = await fetch(playerUrlMatch[1]);
    const js = await jsRes.text();

    // Найти имя функции decipher
    const fnName = js.match(/b=a\.get\("signature"\)\)a=a\.split\(""\);(\w+)\(/)?.[1]
      || js.match(/var \w+=\w+\.split\(""\),(\w+)=\[/)?.[1]
      || js.match(/(\w+)\s*=\s*function\(\s*\w+\s*\)\s*\{\s*\w+\.reverse\(\)/)?.[1];
    if (!fnName) return null;

    // Тело функции
    const fnBodyMatch = js.match(new RegExp(`var\\s+${fnName}\\s*=\\s*function\\s*\\(\\s*\\w+\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\};`))
      || js.match(new RegExp(`function\\s+${fnName}\\s*\\(\\s*\\w+\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
    if (!fnBodyMatch) return null;
    const fnBody = fnBodyMatch[1];

    // Helper-объект
    const helperMatch = fnBody.match(/(\w+)\./);
    const helperName = helperMatch?.[1];
    let helperBody = '';
    if (helperName) {
      const hMatch = js.match(new RegExp(`var\\s+${helperName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*;`));
      if (hMatch) helperBody = `var ${helperName}={${hMatch[1]}};`;
    }

    const code = `${helperBody}\nvar ${fnName}=function(a){a=a.split("");${fnBody}\nreturn a.join("");};\nreturn ${fnName};`;
    _decipherFn = new Function(code)();
    return _decipherFn;
  } catch (e) {
    console.error('decipher error:', e?.message);
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
  } catch { return null; }
}

// ── Download ────────────────────────────────────────────────────────────────

function fixGooglevideoUrl(url) {
  if (url && url.includes('googlevideo.com')) {
    if (!url.includes('ratebypass=')) url += (url.includes('?') ? '&' : '?') + 'ratebypass=yes';
    if (!url.includes('range=')) url += (url.includes('?') ? '&' : '?') + 'range=0-';
  }
  return url;
}

async function download(url, ua, env) {
  const headers = { 'User-Agent': ua || 'Mozilla/5.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' };
  if (env?.YT_COOKIE) headers.Cookie = env.YT_COOKIE;
  const fixedUrl = fixGooglevideoUrl(url);
  const res = await fetch(fixedUrl, { redirect: 'follow', headers });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 10000) return null;
  return { buf };
}

// ── 1. Скрапинг страницы видео ──────────────────────────────────────────────

async function fromWatchPage(env, vidId, errors) {
  if (!env.YT_COOKIE) return null;
  const ua = WEB_CLIENTS[0].ua;
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${vidId}&hl=en`, {
      headers: await authHeaders(env, { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html' }),
    });
    const html = await res.text();

    // ytInitialPlayerResponse = {...};
    let data = extractJsonAt(html, 'ytInitialPlayerResponse');
    if (!data) {
      // ytInitialPlayerResponse":{...}
      data = extractJsonAt(html, '"ytInitialPlayerResponse"');
    }
    if (!data) { errors.push('WATCH: нет ytInitialPlayerResponse'); return null; }

    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') { errors.push(`WATCH: ${status}`); }

    const formats = [...(data?.streamingData?.adaptiveFormats || []), ...(data?.streamingData?.formats || [])];
    const audio = formats
      .filter((f) => (f.mimeType || '').startsWith('audio') && (f.url || f.signatureCipher))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    if (!audio) { errors.push('WATCH: нет аудио форматов'); return null; }

    let url = audio.url;
    if (!url && audio.signatureCipher) {
      const dec = await getDecipher(env);
      if (!dec) { errors.push('WATCH: нужен decipher, не удалось'); return null; }
      url = decodeSig(audio.signatureCipher, dec);
      if (!url) { errors.push('WATCH: ошибка decipher'); return null; }
    }
    if (!url) { errors.push('WATCH: нет URL'); return null; }

    const file = await download(url, ua, env);
    if (file) {
      const m4a = /mp4/.test(audio.mimeType || '');
      const title = data?.videoDetails?.title || 'audio';
      return { ...file, filename: `${title}.${m4a ? 'm4a' : 'webm'}`, mime: m4a ? 'audio/mp4' : 'audio/webm' };
    }
    errors.push('WATCH: файл пустой');
  } catch (err) {
    errors.push(`WATCH: ${short(err)}`);
  }
  return null;
}

// ── 2. InnerTube (RAW клиенты) ──────────────────────────────────────────────

async function fromInnertubeRaw(env, vidId, errors) {
  for (const c of RAW_CLIENTS) {
    const client = { clientName: c.name, clientVersion: c.ver, hl: 'en', gl: 'US' };
    if (c.sdk) client.androidSdkVersion = c.sdk;
    if (c.screen) client.clientScreen = c.screen;
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
          body: JSON.stringify({ context: { client }, videoId: vidId, contentCheckOk: true, racyCheckOk: true }) }
      );
      const data = await res.json().catch(() => ({}));
      const status = data?.playabilityStatus?.status;
      if (status && status !== 'OK') { errors.push(`${c.name}: ${status}`); continue; }

      const formats = [...(data?.streamingData?.adaptiveFormats || []), ...(data?.streamingData?.formats || [])];
      const audio = formats
        .filter((f) => (f.mimeType || '').startsWith('audio') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!audio) { errors.push(`${c.name}: нет прямой ссылки`); continue; }

      const file = await download(audio.url, c.ua, null);
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

// ── 3. InnerTube (WEB с cookie) ─────────────────────────────────────────────

async function fromInnertubeWeb(env, vidId, errors) {
  if (!env.YT_COOKIE) return null;
  const dec = await getDecipher(env);
  for (const c of WEB_CLIENTS) {
    const client = { clientName: c.name, clientVersion: c.ver, hl: 'en', gl: 'US' };
    if (c.screen) client.clientScreen = c.screen;
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        { method: 'POST', headers: await authHeaders(env, { 'Content-Type': 'application/json', 'User-Agent': c.ua }),
          body: JSON.stringify({ context: { client }, videoId: vidId, contentCheckOk: true, racyCheckOk: true }) }
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
        if (!dec) { errors.push(`${c.name}: нужен decipher, не удалось`); continue; }
        url = decodeSig(audio.signatureCipher, dec);
        if (!url) { errors.push(`${c.name}: ошибка decipher`); continue; }
      }
      if (!url) { errors.push(`${c.name}: нет URL`); continue; }

      const file = await download(url, c.ua, env);
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

// ── 4. Cobalt ───────────────────────────────────────────────────────────────

async function fromCobalt(env, ytUrl, errors) {
  const api = (env.COBALT_API || '').trim();
  if (!api) return null;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (env.COBALT_KEY) headers.Authorization = `Api-Key ${env.COBALT_KEY}`;
  try {
    const res = await fetch(api, { method: 'POST', headers, body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3' }) });
    const data = await res.json().catch(() => ({}));
    const link = data.url || data.picker?.[0]?.url;
    if (!link) { errors.push(`cobalt: ${data.error?.code || data.text || res.status}`); return null; }
    const file = await download(link, 'Mozilla/5.0', null);
    if (!file) { errors.push('cobalt: файл пустой'); return null; }
    return { ...file, filename: data.filename || 'audio.mp3', mime: 'audio/mpeg' };
  } catch (err) {
    errors.push(`cobalt: ${short(err)}`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function getAudio(env, ytUrl) {
  const errors = [];
  const vid = videoId(ytUrl);
  const result =
    (vid && (await fromWatchPage(env, vid, errors))) ||
    (vid && (await fromInnertubeRaw(env, vid, errors))) ||
    (vid && (await fromInnertubeWeb(env, vid, errors))) ||
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
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendAudio`, { method: 'POST', body: form });
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
      text: hello ? 'Привет! 👋\nКинь ссылку на видео YouTube — пришлю аудио 🎵' : 'Пришли ссылку на видео YouTube — пришлю аудио 🎵',
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
      throw new Error(/too big/i.test(sent.description || '') ? 'файл больше 50 MB — лимит Telegram' : sent.description || 'Telegram не принял файл');
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
      if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok');
    }
    return new Response('ytg-bot is running', { status: 200 });
  },
};
