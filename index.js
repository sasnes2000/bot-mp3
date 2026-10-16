const URL_RE =
  /(https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+)/i;

const tg = (env, method, payload) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

const edit = (env, chatId, messageId, text) =>
  tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  }).catch(() => {});

const DEFAULT_COBALT = [
  'https://co.wuk.sh/',
  'https://cobalt-api.kwiatekmiki.com/',
];

const DEFAULT_INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.f5.si',
  'https://iv.melmac.space',
  'https://invidious.privacyredirect.com',
];

function videoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function cobaltList(env) {
  const raw = (env.COBALT_API || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (raw.length ? raw : DEFAULT_COBALT).map((u) => (u.endsWith('/') ? u : u + '/'));
}

function invidiousList(env) {
  const raw = (env.INVIDIOUS_API || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (raw.length ? raw : DEFAULT_INVIDIOUS).map((u) => u.replace(/\/$/, ''));
}

async function tryCobalt(env, ytUrl, errs) {
  for (const api of cobaltList(env)) {
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (env.COBALT_KEY) headers.Authorization = `Api-Key ${env.COBALT_KEY}`;
      const res = await fetch(api, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: ytUrl,
          downloadMode: 'audio',
          audioFormat: 'mp3',
          filenameStyle: 'basic',
        }),
      });
      const data = await res.json().catch(() => ({}));
      const link = data.url || (data.picker && data.picker[0] && data.picker[0].url);
      if (link) {
        const check = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const buf = await check.arrayBuffer();
        if (buf.byteLength) return { buf, filename: data.filename || 'audio.mp3', mime: 'audio/mpeg' };
        errs.push(`${api} → пустой файл`);
      } else {
        const e = data.error;
        errs.push(`${api} → ${(e && (e.code || (typeof e === 'string' ? e : JSON.stringify(e)))) || data.text || res.status}`);
      }
    } catch (err) {
      errs.push(`${api} → ${String(err.message || err).slice(0, 50)}`);
    }
  }
  return null;
}

async function tryInvidious(env, vidId, errs) {
  for (const base of invidiousList(env)) {
    try {
      let title = 'YouTube';
      try {
        const meta = await fetch(`${base}/api/v1/videos/${vidId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (meta.ok) title = (await meta.json()).title || title;
      } catch {}
      const res = await fetch(
        `${base}/latest_version?id=${vidId}&itag=140&local=true`,
        { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1000) return { buf, filename: `${title}.m4a`, mime: 'audio/mp4' };
      errs.push(`${base} → пусто (${res.status})`);
    } catch (err) {
      errs.push(`${base} → ${String(err.message || err).slice(0, 50)}`);
    }
  }
  return null;
}

async function resolveAudio(env, ytUrl) {
  const errs = [];
  const got = (await tryCobalt(env, ytUrl, errs)) || (await tryInvidious(env, videoId(ytUrl), errs));
  if (got) return got;
  throw new Error(errs.join('\n'));
}

async function sendAudio(env, chatId, buf, title, mime) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('title', title);
  form.append('performer', 'YouTube');
  form.append('audio', new Blob([buf], { type: mime }), `${title}.mp3`);

  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendAudio`, {
    method: 'POST',
    body: form,
  });
  return r.json();
}

async function handleUpdate(update, env) {
  const message = update.message || update.channel_post;
  const text = message?.text || '';
  const chatId = message?.chat?.id;
  if (!chatId) return;

  const match = text.match(URL_RE);
  if (!match) {
    const help = /^\/(start|help)/.test(text.trim())
      ? 'Привет! 👋\nКинь ссылку на видео YouTube — пришлю MP3 🎵'
      : 'Пришли ссылку на видео YouTube — пришлю MP3 🎵';
    await tg(env, 'sendMessage', { chat_id: chatId, text: help });
    return;
  }

  const status = await tg(env, 'sendMessage', { chat_id: chatId, text: '⏳ Готовлю MP3...' });
  const statusId = status?.result?.message_id;

  try {
    const { buf, filename, mime } = await resolveAudio(env, match[1]);

    if (statusId) await edit(env, chatId, statusId, '📤 Отправляю файл...');

    const sent = await sendAudio(env, chatId, buf, filename.replace(/\.[a-z0-9]+$/i, ''), mime);

    if (!sent.ok) {
      throw new Error(
        /too big/i.test(sent.description || '')
          ? 'файл больше 50 MB — лимит Telegram-бота'
          : sent.description || 'Telegram не принял файл'
      );
    }

    if (statusId) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: statusId });
  } catch (err) {
    const msg = `❌ Не получилось:\n${String(err.message || err).slice(0, 900)}`;
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
