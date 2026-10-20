// Telegram YouTube -> MP3 bot for Cloudflare Pages (drag-and-drop ZIP).
// Conversion is performed by the external YTMP3.GE API, not by Cloudflare.
const CONVERTER_URL = 'https://ytmp3.ge/api/convert';
const MAX_MP3_BYTES = 50 * 1024 * 1024;
const TELEGRAM_URL = 'https://api.telegram.org/bot';
const HELP_TEXT =
  '🎧 Привет! Пришли ссылку на YouTube или YouTube Shorts, и я попробую отправить MP3.\n\n' +
  '✅ Обычные видео и Shorts\n' +
  '⚠️ Длинные видео могут не обработаться из-за ограничений Cloudflare и внешнего конвертера.\n' +
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

function safeAudioUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        /^(?:10|127|0|192\.168|169\.254)\./.test(host) || host === '[::1]') return null;
    return url.href;
  } catch { return null; }
}

async function convert(videoUrl) {
  const response = await fetch(CONVERTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ youtube_url: videoUrl, quality: '192' }).toString(),
    signal: AbortSignal.timeout(20500),
  });
  if (!response.ok) throw new Error(`Конвертер вернул HTTP ${response.status}`);
  const content = await response.json().catch(() => null);
  if (!content || content.success !== true) {
    throw new Error(`Не удалось конвертировать: ${String(content?.error || 'ошибка API').slice(0, 150)}`);
  }
  const url = safeAudioUrl(content.downloadUrl);
  if (!url) throw new Error('Конвертер не прислал безопасную ссылку на MP3');
  const size = Number(content.size || 0);
  if (size && size > MAX_MP3_BYTES) throw new Error('MP3 больше 50 МБ — Telegram его не примет');
  return { url, title: String(content.title || 'YouTube Audio').slice(0, 90), size };
}

async function sendMp3(env, chatId, track) {
  // Telegram fetches MP3 by URL itself. Up to 20MB by URL; server upload up to 50MB.
  // This does not use Cloudflare RAM to store the audio file.
  if (!track.size || track.size <= 20 * 1024 * 1024) {
    try {
      return await telegram(env, 'sendAudio', {
        chat_id: chatId,
        audio: track.url,
        title: track.title,
      }, 9500);
    } catch (error) {
      console.warn('URL-based sendAudio failed; trying a streamed upload:', String(error));
    }
  }
  return uploadMp3Stream(env, chatId, track);
}

async function uploadMp3Stream(env, chatId, track) {
  const response = await fetch(track.url, { signal: AbortSignal.timeout(11000) });
  if (!response.ok || !response.body) throw new Error(`Не удалось получить MP3: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (/text\/html|application\/json/i.test(contentType)) throw new Error('Вместо MP3 сервис вернул страницу');
  const size = Number(response.headers.get('content-length') || track.size || 0);
  if (size > MAX_MP3_BYTES) throw new Error('Аудио больше 50 МБ');

  const boundary = 'CFMP3_' + crypto.randomUUID().replace(/-/g, '');
  const enc = new TextEncoder();
  const heading = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${track.title}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const reader = response.body.getReader();
  let state = 0, bytes = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (state === 0) {
        state = 1;
        controller.enqueue(heading);
        return;
      }
      if (state === 1) {
        const {done, value} = await reader.read();
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
    signal: AbortSignal.timeout(18000),
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
  await sendText(env, chatId, '⏳ Конвертирую в MP3… Обычно это занимает несколько секунд.');
  try {
    const track = await convert(videoUrl);
    await sendMp3(env, chatId, track);
  } catch (error) {
    console.error('MP3 conversion error:', String(error));
    try {
      await sendText(env, chatId, '❌ Не получилось получить MP3. Попробуй более короткое видео или повтори позже. Внешний сервис может быть недоступен.');
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
