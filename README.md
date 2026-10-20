# Cloudflare Pages Telegram → noTube MP3 (ЭКСПЕРИМЕНТАЛЬНО)

**Это прототип, а не подтверждённо работающий конвертер.**

Исходный код использует внутренние POST-запросы `recover_weight.php` / `recover_file.php`, которые обнаружены в стороннем открытом клиенте noTube (https://github.com/sattorbekh/youtube-downloader/blob/main/src/youtubDownloader.js). Они **не являются публичным API** и могут устареть, поменяться или блокироваться в Cloudflare. В этой среде реально вызвать noTube POST и проверить MP3 не удалось. Пройдены только синтаксическая проверка и имитационный тест всего потока (включая multipart MP3 в Telegram).

## Обновление работающего Pages проекта

1. Замени `_worker.js` на этот файл в GitHub-репозитории, подключенном к проекту Cloudflare Pages.
2. Дождись статуса Production success в Cloudflare → Workers & Pages → твой Pages проект → Deployments.
3. В Pages → Settings → Variables and Secrets должны остаться существующие `TELEGRAM_BOT_TOKEN`, `SETUP_KEY` в Production. Новый API-ключ **не нужен**.
4. Если `SETUP_KEY` не менялся и webhook уже правильно подключён, перенастраивать Telegram webhook не надо.
5. Отправь боту короткий YouTube-ролик **на который у тебя есть права**.
6. При ошибке открой логи Pages Functions и найди `noTube MP3 conversion error`. Особенно полезна стадия `recover_weight`, `recover_file`, `download page` или `streaming failed`.

## Окружение

- `TELEGRAM_BOT_TOKEN` — Secret, токен от BotFather.
- `SETUP_KEY` — Secret, пароль из латинских букв, цифр, `_` или `-` (8–128 символов). Этот пароль используется и как секрет Telegram webhook.
- `ALLOWED_USER_IDS` — необязательный список Telegram User ID через запятую, чтобы ограничить личное использование (рекомендуется).

При замене `SETUP_KEY` вызови заново `/setup?key=...` в браузере, чтобы обновить secret Telegram webhook.

Проверить конфигурацию: `/health`. Зарегистрировать webhook: `/setup?key=...`. В целях безопасности не показывай другим людям токен и setup key; ранее раскрытые секреты лучше заменить.

## Важные ограничения

- Это **неофициальная интеграция**: noTube не гарантирует стабильную работу внутренних маршрутов или автоматизированных запросов.
- В noTube Terms of Use описаны ограничения для автоматизированного и коммерческого использования, а также ограничения авторских прав: https://notube.net/en/terms . Не превышай обычную ручную нагрузку; не обходи ограничения сайта.
- Cloudflare может отменить фоновую задачу после 30 секунд ожидания, когда webhook уже ответил. Для надёжных долгих конвертаций нужен другой фоновый исполнитель.
- Telegram Bot API ограничивает отправляемый аудиофайл; код ограничивает MP3 50 MB и поточно передаёт его в Telegram, не сохраняя на Cloudflare.
- Прототип **не** обходится с DRM и защищённым контентом.

Не выкладывай лог с реальным `x-telegram-bot-api-secret-token` или с токеном BotFather.
