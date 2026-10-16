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

const DEFAULT_COBALT = ['https://co.wuk.sh/', 'https://cobalt-api.kwiatekmiki.com/'];

const DEFAULT_PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.drgns.space',
  'https://piapi.ggtyler.dev',
  'https://pipedapi.ducks.party',
];

const DEFAULT_INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://iv.melmac.space',
];

function videoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const list = (env, name, defaults) => {
  const raw = (env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : defaults;
};

async function grab(url, minBytes = 100000) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
  const ct = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  return { ok: buf.byteLength >= minBytes, status: res.status, ct, buf, len: buf.byteLength };
}

async function tryCobalt(env, ytUrl, errs) {
  for (const api of list(env, 'COBALT_API', DEFAULT_COBALT)) {
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (env.COBALT_KEY) headers.Authorization = `Api-Key ${env.COBALT_KEY}`;
      const res = await fetch(api, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3', filenameStyle: 'basic' }),
      });
      const data = await res.json().catch(() => ({}));
      const link = data.url || (data.picker && data.picker[0] && data.picker[0].url);
      if (link) {
        const g = await grab(link);
        if (g.ok) return { buf: g.buf, filename: data.filename || 'audio.mp3', mime: 'audio/mpeg' };
        errs.push(`${api} → пусто (${g.len})`);
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

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

const CLIENTS = [
  { name: 'ANDROID', ver: '19.09.37', sdk: 30, ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip' },
  { name: 'ANDROID_VR', ver: '1.60.19', sdk: 32, ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip' },
  { name: 'IOS', ver: '19.09.3', sdk: null, ua: 'com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)' },
];

async function tryInnerTube(env, vidId, errs) {
  for (const c of CLIENTS) {
    try {
      const client = { clientName: c.name, clientVersion: c.ver, hl: 'en', gl: 'US' };
      if (c.sdk) client.androidSdkVersion = c.sdk;
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
          body: JSON.stringify({
            context: { client },
            videoId: vidId,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      const playability = data?.playabilityStatus?.status;
      if (playability && playability !== 'OK') {
        errs.push(`innertube/${c.name} → ${playability}`);
        continue;
      }
      const formats = (data?.streamingData?.adaptiveFormats || []).filter(
        (f) => (f.mimeType || '').startsWith('audio') && f.url
      );
      formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!formats.length) {
        errs.push(`innertube/${c.name} → нет прямых аудио-ссылок`);
        continue;
      }
      const f = formats[0];
      const g = await grab(f.url, 50000);
      if (g.ok) {
        const mime = /mp4/.test(f.mimeType) ? 'audio/mp4' : 'audio/webm';
        const title = data?.videoDetails?.title || 'audio';
        return { buf: g.buf, filename: `${title}.${mime === 'audio/mp4' ? 'm4a' : 'webm'}`, mime };
      }
      errs.push(`innertube/${c.name} → пусто (${g.status} ${g.len})`);
    } catch (err) {
      errs.push(`innertube/${c.name} → ${String(err.message || err).slice(0, 50)}`);
    }
  }
  return null;
}

async function tryPiped(env, vidId, errs) {
  for (const base of list(env, 'PIPED_API', DEFAULT_PIPED)) {
    try {
      const res = await fetch(`${base}/streams/${vidId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        errs.push(`${base} → ${res.status}`);
        continue;
      }
      const data = await res.json();
      const streams = (data.audioStreams || []).filter((s) => s.url);
      streams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!streams.length) {
        errs.push(`${base} → нет аудио (${data.error || '?'})`);
        continue;
      }
      const g = await grab(streams[0].url);
      if (g.ok) {
        const ext = /mp4|m4a/.test(streams[0].mimeType || '') ? 'm4a' : 'webm';
        const mime = ext === 'm4a' ? 'audio/mp4' : 'audio/webm';
        return { buf: g.buf, filename: `${data.title || 'audio'}.${ext}`, mime };
      }
      errs.push(`${base} → пусто (${g.len})`);
    } catch (err) {
      errs.push(`${base} → ${String(err.message || err).slice(0, 50)}`);
    }
  }
  return null;
}

async function tryInvidious(env, vidId, errs) {
  for (const base of list(env, 'INVIDIOUS_API', DEFAULT_INVIDIOUS)) {
    try {
      let title = 'audio';
      try {
        const meta = await fetch(`${base}/api/v1/videos/${vidId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (meta.ok) title = (await meta.json()).title || title;
      } catch {}
      const g = await grab(`${base}/latest_version?id=${vidId}&itag=140&local=true`);
      if (g.ok && /audio|video|octet-stream/.test(g.ct)) {
        return { buf: g.buf, filename: `${title}.m4a`, mime: 'audio/mp4' };
      }
      errs.push(`${base} → ${g.status} ct=${g.ct.slice(0, 20)} len=${g.len}`);
    } catch (err) {
      errs.push(`${base} → ${String(err.message || err).slice(0, 50)}`);
    }
  }
  return null;
}

async function resolveAudio(env, ytUrl) {
  const errs = [];
  const vid = videoId(ytUrl);
  const got =
    (vid && (await tryInnerTube(env, vid, errs))) ||
    (await tryCobalt(env, ytUrl, errs)) ||
    (vid && (await tryPiped(env, vid, errs))) ||
    (vid && (await tryInvidious(env, vid, errs)));
  if (got) return got;
  throw new Error(errs.join('\n'));
}

async function sendAudio(env, chatId, buf, title, mime) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('title', title);
  form.append('performer', 'YouTube');
  form.append('audio', new Blob([buf], { type: mime }), `${title}.m4a`);

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
