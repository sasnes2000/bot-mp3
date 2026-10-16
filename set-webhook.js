// Usage:
//   BOT_TOKEN=123:abc WORKER_URL=https://ytg-bot.you.workers.dev WEBHOOK_SECRET=supersecret node scripts/set-webhook.js
const { BOT_TOKEN, WORKER_URL, WEBHOOK_SECRET } = process.env;

if (!BOT_TOKEN || !WORKER_URL) {
  console.error('Set BOT_TOKEN and WORKER_URL (e.g. https://ytg-bot.<sub>.workers.dev)');
  process.exit(1);
}

const params = new URLSearchParams({ url: `${WORKER_URL.replace(/\/$/, '')}/webhook` });
if (WEBHOOK_SECRET) params.set('secret_token', WEBHOOK_SECRET);
params.set('drop_pending_updates', 'true');

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?${params}`, {
  method: 'POST',
});
console.log(await res.json());
