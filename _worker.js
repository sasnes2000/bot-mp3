// Telegram YouTube -> MP3 bot for Cloudflare Pages (drag-and-drop ZIP).
// Conversion is performed by third-party services, not Cloudflare.
// noTube trial: undocumented web form endpoints; not guaranteed to work.
const NOTUBE_HOST = 'https://s47.notube.net'; // Seen in an unofficial public client; may change.
const MAX_MP3_BYTES = 50 * 1024 * 1024;
const TELEGRAM_URL = 'https://api.telegram.org/bot';
const HELP_TEXT =
  '🎧 Привет! Пришли ссылку на YouTube или YouTube Shorts, и я попробую отправить MP3.\n\n' +
  '✅ Обычные видео и Shorts\n' +
  '⚠️ noTube использует неофициальные внутренние запросы; доступность не гарантируется.\n' +
  'Скачивай только контент, на который у тебя есть права.';

function getIdFromMessage(messageText) {
  const match = String(messageText || '').match(/(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"']+/i);
  if (!match) return null;
  let raw = match[0].replace(/[),;.!?]+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  let videoId = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    videoId = url.pathname.split('/')[1];
  } else if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    else {
      const bits = url.pathname.split('/');
      if (['shorts','live','embed'].includes(bits[1])) videoId = bits[2];
    }
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function configured(env) {
  return typeof env.TELEGRAM_BOT_TOKEN === 'string' && env.TELEGRAM_BOT_TOKEN.length > 20 &&
    typeof env.SETUP_KEY === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(env.SETUP_KEY);
}

async function telegram(env, method, params, timeoutMs = 12000) {
  const response = await fetch(`${TELEGRAM_URL}${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || response.status}`);
  }
  return data.result;
}

async function sendText(env, chatId, text) {
  return telegram(env, 'sendMessage', { chat_id: chatId, text });
}

function safeAudioUrl(value, baseUrl = 'https://notube.net/') {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.replace(/&amp;/g, '&'), baseUrl);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local') ||
      /^(?:10|127|0|192\.168|169\.254)\./.test(host) || host === '[::1]') return null;
    return u.href;
  } catch { return null; }
}

const ntHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://notube.net',
  'Referer': 'https://notube.net/ru/youtube-app-441',
};
async function ntPost(path, fields, timeout = 7000, requireJson = true) {
  const response = await fetch(`${NOTUBE_HOST}${path}`, {
    method: 'POST', headers: ntHeaders,
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`noTube ${path}: HTTP ${response.status}`);
  const raw = await response.text();
  try { return JSON.parse(raw); }
  catch { if (!requireJson) return { raw }; throw new Error(`noTube ${path}: неверный ответ ${response.headers.get('content-type') || 'без типа'}`); }
}
function extractDownloadLink(html, baseUrl) {
  const decoded = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const anchors = decoded.match(/<a\b[^>]*>/gi) || [];
  for (const a of anchors) {
    if (/\bid=["']downloadButton["']/i.test(a)) {
      const m = a.match(/\bhref=["']([^"']+)["']/i);
      if (m) return safeAudioUrl(m[1], baseUrl);
    }
  }
  // Other versions use a direct download.php link without a button ID.
  const m = decoded.match(/(?:href|location\.href)\s*[=:]\s*["']([^"']*download\.php\?[^"']+)["']/i);
  if (m) return safeAudioUrl(m[1], baseUrl);
  return null;
}
async function convertNoTube(videoUrl) {
  const weight = await ntPost('/recover_weight.php', {
    url: videoUrl, format: 'mp3', lang: 'en', subscribed: 'false',
  });
  if (!weight || typeof weight !== 'object' || !weight.token || !weight.name_mp4) {
    console.warn('noTube recover_weight invalid metadata:', typeof weight, Object.keys(weight || {}).join(','));
    throw new Error('noTube не выдал token/name_mp4 для конвертации');
  }
  const token = String(weight.token);
  const initialization = await ntPost('/recover_file.php?lang=en', {
    url: videoUrl, format: 'mp3', lang: 'en', name_mp4: String(weight.name_mp4),
    token, subscribed: 'false', playlist: 'false', adblock: 'false',
  }, 10000, false);
  if (initialization?.error || initialization?.success === false) {
    throw new Error(`noTube отказал в конвертации: ${String(initialization.error || initialization.message || '').slice(0, 120)}`);
  }
  const pageUrl = `https://notube.net/en/download?token=${encodeURIComponent(token)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const page = await fetch(pageUrl, {
      headers: { 'User-Agent': ntHeaders['User-Agent'], 'Referer': 'https://notube.net/' },
      signal: AbortSignal.timeout(4500),
    });
    if (!page.ok) throw new Error(`noTube download page HTTP ${page.status}`);
    const link = extractDownloadLink(await page.text(), page.url || pageUrl);
    if (link) return { url: link, title: 'YouTube MP3', size: 0 };
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error('noTube не выдал прямую ссылку на MP3 (страница без кнопки скачивания)');
}

async function sendMp3(env, chatId, track) {
  // Prefer streaming bytes from noTube: Telegram often cannot fetch download URLs itself.
  // Do not buffer the MP3 in Worker memory.
  try {
    return await uploadMp3Stream(env, chatId, track);
  } catch (error) {
    console.warn('noTube MP3 streaming failed, trying URL sendAudio:', String(error));
    if (track.size > 20 * 1024 * 1024) throw error;
    return telegram(env, 'sendAudio', { chat_id: chatId, audio: track.url, title: track.title }, 7000);
  }
}

async function uploadMp3Stream(env, chatId, track) {
  const response = await fetch(track.url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok || !response.body) throw new Error(`Не удалось получить MP3: HTTP ${response.status}`);
  return uploadMp3Response(env, chatId, response, track.title, track.size);
}

async function uploadMp3Response(env, chatId, response, title = 'YouTube Audio', knownSize = 0) {
  const mime = (response.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/json/i.test(mime)) throw new Error(`Сервис вернул HTML/JSON вместо MP3 (${mime})`);
  const size = Number(response.headers.get('content-length') || knownSize || 0);
  if (size > MAX_MP3_BYTES) throw new Error('Аудио больше 50 МБ');
  const reader = response.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.length) throw new Error('Сервис вернул пустой файл');
  const b = first.value;
  const looksLikeMp3 = (b.length >= 3 && b[0] === 73 && b[1] === 68 && b[2] === 51) ||
    (b.length >= 2 && b[0] === 255 && (b[1] & 0xe0) === 0xe0);
  if (!looksLikeMp3) {
    await reader.cancel().catch(() => {});
    throw new Error(`Сервис вернул не MP3 (тип ${mime || 'не указан'})`);
  }

  const boundary = 'CFMP3_' + crypto.randomUUID().replace(/-/g, '');
  const enc = new TextEncoder();
  const heading = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  let state = 0, bytes = 0;
  let firstPending = b;
  const stream = new ReadableStream({
    async pull(controller) {
      if (state === 0) {
        state = 1;
        controller.enqueue(heading);
        return;
      }
      if (state === 1) {
        const {done, value} = firstPending ? {done: false, value: firstPending} : await reader.read();
        firstPending = null;
        if (done) {
          state = 2;
          controller.enqueue(tail);
        } else {
          bytes += value.byteLength;
          if (bytes > MAX_MP3_BYTES) {
            await reader.cancel();
            controller.error(new Error('MP3 превысил ограничение 50 МБ'));
            return;
          }
          controller.enqueue(value);
        }
        return;
      }
      controller.close();
    },
    cancel() { reader.cancel().catch(() => {}); }
  });
  const uploaded = await fetch(`${TELEGRAM_URL}${env.TELEGRAM_BOT_TOKEN}/sendAudio`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(16000),
  });
  const result = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || !result.ok) throw new Error(`Ошибка загрузки MP3: ${result.description || uploaded.status}`);
  return result.result;
}

async function handleUpdate(env, update) {
  const msg = update?.message;
  if (!msg || !msg.chat?.id) return;
  const chatId = msg.chat.id;
  const allowlist = String(env.ALLOWED_USER_IDS || '').trim();
  if (allowlist && !allowlist.split(',').map(x => x.trim()).includes(String(msg.from?.id || ''))) return;
  const input = String(msg.text || msg.caption || '');
  if (!input || /^\/(start|help)(?:@\w+)?(?:\s|$)/i.test(input)) {
    await sendText(env, chatId, HELP_TEXT);
    return;
  }
  const videoUrl = getIdFromMessage(input);
  if (!videoUrl) {
    await sendText(env, chatId, '🔗 Отправь ссылку вида https://youtu.be/VIDEO_ID или на YouTube Shorts.');
    return;
  }
  await sendText(env, chatId, '⏳ Получаю MP3… Подожди немного.');
  try {
    const track = await convertNoTube(videoUrl);
    await sendMp3(env, chatId, track);
  } catch (error) {
    console.error('noTube MP3 conversion error:', String(error));
    try {
      await sendText(env, chatId, '❌ Не удалось получить MP3 через noTube. Сервис может отклонять автоматические запросы. Попробуй позже.');
    } catch (sendError) {
      console.error('Could not send error message:', String(sendError));
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    if (u.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, configured: configured(env), service: 'YouTube → Telegram MP3' });
    }
    if (u.pathname === '/setup' && request.method === 'GET') {
      if (!configured(env)) return new Response('Set TELEGRAM_BOT_TOKEN and SETUP_KEY secrets in Cloudflare Pages.', {status: 503});
      if (u.searchParams.get('key') !== env.SETUP_KEY) return new Response('Incorrect setup key.', {status: 403});
      try {
        const webhook = `${u.origin}/webhook`;
        await telegram(env, 'setWebhook', {
          url: webhook,
          secret_token: env.SETUP_KEY,
          allowed_updates: ['message'],
          drop_pending_updates: true,
        });
        return new Response('✅ Webhook registered! Open your Telegram bot and send a YouTube link.\n', {headers: {'Content-Type': 'text/plain; charset=utf-8'}});
      } catch (error) {
        return new Response('Webhook setup failed. Check the BOT token and Cloudflare logs.', {status: 502});
      }
    }
    if (u.pathname === '/webhook' && request.method === 'POST') {
      if (!configured(env)) return new Response('Bot not configured', {status: 503});
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SETUP_KEY) return new Response('Forbidden', {status: 403});
      let update;
      try { update = await request.json(); } catch { return new Response('Bad JSON', {status: 400}); }
      ctx.waitUntil(handleUpdate(env, update));
      return new Response('OK');
    }
    if (u.pathname === '/webhook') return new Response('Use Telegram webhook POST', {status: 405});
    return env.ASSETS.fetch(request);
  },
};
