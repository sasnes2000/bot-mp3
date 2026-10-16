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

const DEFAULT_INSTANCES = [
  'https://co.wuk.sh/',
  'https://cobalt-api.kwiatekmiki.com/',
  'https://api.cobalt.best/',
  'https://cobalt.255x.ru/',
  'https://api.cobalt.tools/',
];

function instances(env) {
  const raw = (env.COBALT_API || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = raw.length ? raw : DEFAULT_INSTANCES;
  return list.map((u) => (u.endsWith('/') ? u : u + '/'));
}

async function resolveAudio(env, ytUrl) {
  const urls = instances(env);
  let lastErr;
  for (const api of urls) {
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
      if (data.status === 'tunnel' || data.status === 'redirect') {
        const link = data.url || (data.picker && data.picker[0] && data.picker[0].url);
        if (link) {
          const check = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
          const buf = await check.arrayBuffer();
          if (buf.byteLength) return { buf, filename: data.filename || 'audio.mp3' };
          lastErr = new Error(`${api} → пустой файл`);
        } else {
          lastErr = new Error(`${api} → нет ссылки`);
        }
      } else {
        const e = data.error;
        lastErr = new Error(
          (e && (e.code || (typeof e === 'string' ? e : JSON.stringify(e)))) || data.text || `${api} → ${res.status}`
        );
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('все инстансы не сработали');
}

async function sendAudio(env, chatId, buf, title) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('title', title);
  form.append('performer', 'YouTube');
  form.append('audio', new Blob([buf], { type: 'audio/mpeg' }), `${title}.mp3`);

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

  const status = await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: '⏳ Готовлю MP3...',
  });
  const statusId = status?.result?.message_id;

  try {
    const { buf, filename } = await resolveAudio(env, match[1]);

    if (statusId) await edit(env, chatId, statusId, '📤 Отправляю файл...');

    const sent = await sendAudio(env, chatId, buf, filename.replace(/\.mp3$/i, ''));

    if (!sent.ok) {
      throw new Error(
        /too big/i.test(sent.description || '')
          ? 'файл больше 50 MB — лимит Telegram-бота'
          : sent.description || 'Telegram не принял файл'
      );
    }

    if (statusId) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: statusId });
  } catch (err) {
    const msg = `❌ Не получилось: ${String(err.message || err).slice(0, 600)}`;
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
