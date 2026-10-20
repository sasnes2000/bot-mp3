# Telegram YouTube → MP3 Bot — Cloudflare Pages

Готовый ZIP для **Cloudflare Pages → Direct Upload → Drag and drop**. Никакой Python, Node.js, FFmpeg или VPS не нужен. Конвертацию выполняет **сторонний сервис YTMP3.GE**, а Cloudflare Pages получает ссылку и отправляет MP3 в Telegram.

## Как запустить через сайт Cloudflare

1. Открой **https://t.me/BotFather** → `/newbot`, создай Telegram-бота и скопируй его токен.
2. Открой **https://dash.cloudflare.com/** → **Workers & Pages** → **Create application** → **Pages / Drag and drop**. Загрузите ZIP с проектом **целиком** (или его содержимое), укажите название, нажми **Deploy site**.
3. Открой проект в Cloudflare → **Settings → Variables and Secrets** → Add и добавь **два Secret в Production**:
   - `TELEGRAM_BOT_TOKEN` — токен, который дал BotFather, например `1234567890:AA...` (не публикуй!).
   - `SETUP_KEY` — придуманный тобой пароль латинскими буквами/цифрами, минимум 8 символов, например `MyMp3BotKey123456` (не используй данный пример буквально).
   - Необязательно: `ALLOWED_USER_IDS` — ID пользователей Telegram через запятую. Если пусто, бот доступен всем. Свой числовой ID можно узнать у специальных Telegram userinfo-ботов.
4. После добавления секретов при необходимости **сделай новый deployment того же ZIP**, чтобы новые значения попали в окружение (Cloudflare может требовать повторную публикацию).
5. Открой `https://ИМЯ-ПРОЕКТА.pages.dev/health`. Ожидаемый ответ: `"configured":true`.
6. **Привяжи Telegram webhook:** в адресной строке браузера открой:
   `https://ИМЯ-ПРОЕКТА.pages.dev/setup?key=ТВОЙ_SETUP_KEY`
   Ожидаемый ответ: `✅ Webhook registered!`
7. Открой своего бота в Telegram, нажми Start и отправь ссылку YouTube.

## Ограничения

- Только отдельные видео. Поддерживаются youtube.com, youtu.be, Shorts и ссылки youtube.com/live; они нормализуются до стандартного формата.
- Внешний API: https://ytmp3.ge/api/docs — **бесплатный, без ключа по его документации на 20 октября 2026 г.**; доступность не гарантируется. Он может менять условия, блокировать Cloudflare или конвертировать слишком долго.
- У Cloudflare Pages `ctx.waitUntil()` есть лимит около **30 секунд** после ответа вебхуку Telegram. Если конвертация слишком долгая, обработка может оборваться без ответа. Для гарантированного ожидания несколько минут понадобятся отдельная очередь/воркер или серверная обработка.
- Telegram принимает аудио до **50 МБ** через загрузку (multipart/form-data), но через ссылку — до **20 МБ**. Код сперва пробует URL (если размер до 20 МБ), затем потоковую загрузку через Cloudflare, если потребуется.
- Файлы скачиваются **только если у тебя есть право на их использование**; учитывай авторские права и условия YouTube.
- Храни ключи только в Cloudflare Secrets. **Не вставляй Telegram токен в ZIP** и не присылай его в чат.

## Как проверить / исправить проблему

- `/health` → `configured:false`: секреты отсутствуют, неправильно названы либо не применились после публикации.
- `/setup` → `Incorrect setup key`: параметр `key` не совпадает с секретом `SETUP_KEY`.
- `/setup` → `Webhook setup failed`: проверь токен BotFather.
- Бот молчит после Start: заново зайди в `/setup` по адресу **производственного** сайта и проверь Cloudflare → Logs.
- Бот ответил «не получилось»: сторонний конвертер мог не успеть за ~20 секунд, файл мог быть недоступен Telegram, либо сервис блокирует запросы. Попробуй короткое видео. Нет гарантии бесперебойной работы бесплатного API.

Официальная документация: Cloudflare Pages Direct Upload https://developers.cloudflare.com/pages/get-started/direct-upload/; Workers waitUntil https://developers.cloudflare.com/workers/runtime-apis/context/; Telegram Bot API https://core.telegram.org/bots/api.
