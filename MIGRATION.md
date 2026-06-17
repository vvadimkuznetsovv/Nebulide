# Перенос Nebulide на новый сервер

Полный перенос `nebulide.ru` + админки `mega.nebulide.ru` с сохранением всех данных
(чаты/сессии Claude, пользователи, TOTP, доступы) и той же безопасности.

> **Главное:** чаты Claude лежат НЕ в Postgres, а в docker-томе `claude_data` (`/root/.claude`).
> Слепок включает и БД, и этот том — `pg_dump` сам по себе чаты не сохранит.

## Что переезжает / что нет

**В слепке (`scripts/backup-full.sh`, ~1ГБ):**
- БД Postgres — пользователи, password-хэши, TOTP-секреты, refresh-токены, invites, workspace/LLM-сессии
- том `claude_data` — все чаты/сессии/ветки/планы Claude
- тома `shared_data`, `ssh_keys`, `telegram_bot_api_data`
- `.env` (включая `JWT_SECRET` — поэтому никто не разлогинится)
- `/etc/letsencrypt` (SSL)

**НЕ переезжает (по решению — пересобираемое):**
- `/home/nebulide/workspace(s)` — файлы юзеров (сборки из GitHub). _Caveat: незакоммиченные файлы, per-user `.ssh`/`.venv`/история bash в них не переедут._ Нужно — гонять backup с `--with-workspaces`.
- тома `usr_local`, `code-server-config` — dev-тулы и расширения VS Code (поставятся заново). _Бонус: чистый `usr_local` чинит баг с песочницей/Shared в терминале._
- `redis_data` (эфемерный), nginx-логи, scrollback терминалов.

---

## Шаг 1. Поднять новый хост

По инструкции [SERVER-SETUP.md](SERVER-SETUP.md) — шаги 3.1–3.16: система, пользователь `nebulide`,
SSH-хардненинг, ufw, fail2ban, Docker, Go, Node, `/opt/nebulide` (git clone), DH-параметры, certbot.

**Отличия для миграции:**
- Сертификаты certbot — только для **`nebulide.ru`** и **`mega.nebulide.ru`** (edulearn/smartrs не переносим).
  Либо вообще пропусти этот шаг SERVER-SETUP — сертификаты приедут в слепке (шаг 4 положит их в `/etc/letsencrypt`).
- **НЕ запускай** `docker compose up` (шаг 3.18) до восстановления — `restore-full.sh` поднимет стек сам с правильным `.env`.
- `.env` пока можно не заполнять — он приедет из слепка.

## Шаг 2. Снять слепок на СТАРОМ сервере

```bash
ssh nebulide
sudo /opt/nebulide/scripts/backup-full.sh
# → /opt/nebulide/backups/nebulide-snapshot-<TS>.tar.gz
```

## Шаг 3. Перенести архив на новый сервер

Со своей машины:
```bash
scp -P <старый-порт> nebulide:/opt/nebulide/backups/nebulide-snapshot-*.tar.gz .
scp -P <новый-порт>  nebulide-snapshot-*.tar.gz nebulide-new:/tmp/
```
(или напрямую `rsync` старый→новый, если между серверами есть доступ)

## Шаг 4. Восстановить на НОВОМ сервере

```bash
ssh nebulide-new
sudo /opt/nebulide/scripts/restore-full.sh /tmp/nebulide-snapshot-*.tar.gz
```
Скрипт: проверит контрольные суммы → положит `.env` и сертификаты → пересоздаст БД из дампа →
восстановит тома → поднимет стек → покажет число пользователей и проектов Claude.

## Шаг 5. GitHub Secrets (CI/CD на новый сервер)

Settings → Secrets and variables → Actions:
- `SERVER_HOST` → новый IP
- `SERVER_PORT` → новый SSH-порт (если другой)
- `ROOT_PASSWORD` → пароль root нового сервера
- `SSH_PRIVATE_KEY` / `SSH_PASSPHRASE` / `SERVER_USER` — не трогать, если ключ тот же

## Шаг 6. Переключить DNS

A-записи **`nebulide.ru`** и **`mega.nebulide.ru`** → новый IP. Дождаться обновления (TTL).

## Шаг 7. Проверка

```bash
sudo docker compose -f /opt/nebulide/docker-compose.yml ps   # все Up
curl -I https://nebulide.ru                                   # 200/301
```
В браузере: логин теми же кредами (без сброса) → в списке видны старые сессии Claude с именами →
у не-админа работают кнопки Shared и Uploads.

После успешной проверки — вывести старый сервер из эксплуатации.

---

## Что захардкожено под текущий сервер

Только документация и CI (на работу приложения не влияет, поправить при желании):

| Значение | Где |
|---|---|
| IP `45.156.20.105` | SERVER-SETUP.md, SSH-SETUP.md, CLAUDE.md |
| SSH-порт `45191` | SERVER-SETUP.md, SSH-SETUP.md, CLAUDE.md, `~/.ssh/config` |
| домены `nebulide.ru`, `mega.nebulide.ru` | nginx/conf.d/*, certbot |
| email certbot | SERVER-SETUP.md |
| GitHub Secrets (HOST/PORT/ROOT_PASSWORD) | репозиторий на GitHub |

Путь `/opt/nebulide` и `/home/nebulide` менять не нужно — они одинаковы на любом сервере.

## Откат

Слепок не трогает старый сервер. Если на новом что-то не так — переключи DNS обратно,
старый сервер продолжает работать. `restore-full.sh` сохраняет прежний `.env` в `.env.bak-<ts>`.
