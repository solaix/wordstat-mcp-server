# Yandex Wordstat MCP Server

Неофициальный open-source MCP-сервер для Yandex Wordstat API.

Статус: `0.1.0`, активная разработка. npm-пакет ещё не опубликован.

## Инструменты

- `wordstat_top_requests` — популярные и связанные запросы;
- `wordstat_dynamics` — динамика спроса;
- `wordstat_regions` — распределение спроса по регионам;
- `wordstat_regions_tree` — дерево регионов;
- `wordstat_find_regions` — поиск ID региона по названию.

Все инструменты read-only. Вызовы Wordstat API могут тарифицироваться.

## Требования

- Node.js 20.3+;
- API key со scope `yc.search-api.execute` или IAM token;
- роль `search-api.webSearch.user`.

## Локальный запуск

```bash
npm install
npm run build
YANDEX_WORDSTAT_API_KEY='...' node dist/cli.js
```

Нужно задать ровно одну переменную: `YANDEX_WORDSTAT_API_KEY` или `YANDEX_WORDSTAT_IAM_TOKEN`.

`YANDEX_WORDSTAT_FOLDER_ID` обязателен при использовании IAM-токена аккаунта Яндекса или федеративного аккаунта: укажите идентификатор каталога, на который назначена роль `search-api.webSearch.user`. Для API-ключа или IAM-токена сервисного аккаунта переменную можно не задавать — Search API использует каталог сервисного аккаунта.

MCP server name: `yandex-wordstat`. Планируемое имя npm-пакета: `wordstat-mcp-server`.

## Проверка

```bash
npm run check
npm test
npm run smoke:package
```

## License

MIT
