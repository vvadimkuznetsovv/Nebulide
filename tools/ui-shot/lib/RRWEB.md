# rrweb в UI-тестах Nebulide — рецепт

Зачем: Playwright-видео — это просто пиксели. **rrweb** пишет DOM-мутации + действия как поток
событий, а **rrweb-player** воспроизводит их с НАСТОЯЩИМ DOM — можно скраббить, ставить на паузу,
инспектировать элементы (как появилась карточка плана/resume/бар компакта). Это «итоговое видео»,
но инспектируемое.

## Версии / файлы (установлено в tools/ui-shot)
- `rrweb@2.0.1` — рекордер. UMD: `node_modules/rrweb/dist/rrweb.umd.min.cjs`, глобал **`rrweb`** (`.record`).
- `rrweb-player@2.0.1` — плеер. UMD: `node_modules/rrweb-player/dist/rrweb-player.umd.cjs`,
  глобал **`rrwebPlayer`**; CSS: `node_modules/rrweb-player/dist/style.css`.

## Запись (в Playwright-тесте)
Реализовано в `lib/frames.mjs` (`makeHarness`):
- `startRecording()` — читает UMD-бандл рекордера, `page.addScriptTag({ content })` (так бандл
  выполняется в КОНТЕКСТЕ страницы и определяет `window.rrweb`), затем `page.evaluate`:
  ```js
  window.__rr = [];
  window.__rrStop = window.rrweb.record({
    emit: e => window.__rr.push(e),
    inlineStylesheet: true,  // инлайнит same-origin CSS → офлайн-точность
    inlineImages: true,
    collectFonts: true,
  });
  ```
  Вызывать ПОСЛЕ `openClaudeViaChatWindow` — SPA уже стабилен (без полных перезагрузок, иначе
  addScriptTag теряется). Запись фокусируется на самой фиче, без логина.
- `saveRecording()` — `const ev = await page.evaluate(() => window.__rr)`, затем:
  - `recording.js` = `window.__events = <JSON>;` — события кладём JS-присваиванием, НЕ .json:
    `file://` не умеет `fetch`, а `<script src>` грузится.
  - копии `rrweb-player.umd.cjs` + `style.css` рядом.
  - `player.html`: `<link style.css>` → `<script rrweb-player.umd.cjs>` → `<script recording.js>` →
    `new rrwebPlayer({ target, props:{ events: window.__events, width, height, autoPlay:false } })`.

## Просмотр
Открыть `shots/<тест>/player.html` в браузере (двойной клик). Контролы плеера: play/pause,
скраббер, скорость. DOM настоящий → DevTools-инспекция работает.

## Гочи
- **CSP**: Vite-dev обычно без CSP → `addScriptTag({content})` проходит. Если заблокирует —
  `addScriptTag({ path })` (тоже инлайн, но из файла) или ослабить CSP в dev.
- **file:// + JSON**: события только как `recording.js` (присваивание), не fetch'абельный .json.
- **Размер**: события объёмны (inlineImages/Fonts). Это норм для локального просмотра.
- **Старт после openClaude**: при addInitScript на каждую навигацию запись бы рвалась/множилась;
  нам нужен один непрерывный поток вокруг фичи.
