# Yandex Wordstat MCP Server

Неофициальный open-source MCP-сервер, который даёт AI-агентам типизированный read-only доступ ко
всем стандартным методам [Yandex Wordstat API](https://aistudio.yandex.ru/ru/docs/search-api/concepts/wordstat).

> Статус: `0.1.0`, первый публичный релиз.

[English](#english)

## Возможности

- все четыре метода Wordstat API и дополнительный локальный поиск ID региона по названию;
- строгие входные и выходные схемы, безопасные авто-диапазоны дат и проверка операторов;
- повторы временных ошибок с учётом `Retry-After`, таймауты и отмена запросов;
- локальные лимиты RPS, запросов в час и параллельности;
- кэш дерева регионов, дедупликация одновременных запросов и fallback на устаревший кэш;
- счётчики API-вызовов, HTTP-попыток и приблизительно тарифицируемых вызовов;
- stdio-транспорт без записи логов в протокольный `stdout`.

Все инструменты помечены как read-only и idempotent. Запросы к Wordstat являются внешними API-вызовами
и [могут тарифицироваться](https://aistudio.yandex.ru/ru/docs/search-api/pricing).

## Требования и доступ

- Node.js `22.23.4+`, `24.22.1+` или `26.12.1+` в соответствующей LTS-линейке;
- API-ключ со scope `yc.search-api.execute` **или** IAM-токен;
- роль `search-api.webSearch.user` на нужный каталог Yandex Cloud.

Задайте ровно один credential в окружении MCP-клиента:

```bash
export YANDEX_WORDSTAT_API_KEY='your-api-key'
# или: export YANDEX_WORDSTAT_IAM_TOKEN='your-iam-token'
```

Не сохраняйте реальные credentials в репозитории или общей MCP-конфигурации. Перезапустите клиент
после изменения его окружения.

### Когда нужен `YANDEX_WORDSTAT_FOLDER_ID`

Переменная обязательна для IAM-токена аккаунта Яндекса или федеративного аккаунта. Укажите ID каталога,
на который назначена роль `search-api.webSearch.user`:

```bash
export YANDEX_WORDSTAT_FOLDER_ID='b1g...'
```

Для API-ключа или IAM-токена сервисного аккаунта переменную обычно не задают: Search API использует
каталог сервисного аккаунта.

## Подключение к MCP-клиенту

Выберите один способ авторизации: API-ключ **или** IAM-токен. Не передавайте оба одновременно.
В примерах Codex и Claude Code переменные уже экспортированы в окружение процесса клиента.

### Codex CLI / IDE

Добавьте в `~/.codex/config.toml`:

```toml
[mcp_servers.yandex-wordstat]
command = "npx"
args = ["-y", "wordstat-mcp-server@latest"]
env_vars = ["YANDEX_WORDSTAT_API_KEY"]
```

Для IAM-токена аккаунта Яндекса или федеративного аккаунта используйте:

```toml
[mcp_servers.yandex-wordstat]
command = "npx"
args = ["-y", "wordstat-mcp-server@latest"]
env_vars = ["YANDEX_WORDSTAT_IAM_TOKEN", "YANDEX_WORDSTAT_FOLDER_ID"]
```

Затем проверьте подключение командой `codex mcp list`. Codex CLI и IDE используют общую конфигурацию.

### Claude Code

```bash
claude mcp add-json --scope user yandex-wordstat \
  '{"command":"npx","args":["-y","wordstat-mcp-server@latest"],"env":{"YANDEX_WORDSTAT_API_KEY":"${YANDEX_WORDSTAT_API_KEY}"}}'
claude mcp list
```

Вариант с IAM-токеном аккаунта Яндекса или федеративного аккаунта:

```bash
claude mcp add-json --scope user yandex-wordstat \
  '{"command":"npx","args":["-y","wordstat-mcp-server@latest"],"env":{"YANDEX_WORDSTAT_IAM_TOKEN":"${YANDEX_WORDSTAT_IAM_TOKEN}","YANDEX_WORDSTAT_FOLDER_ID":"${YANDEX_WORDSTAT_FOLDER_ID}"}}'
claude mcp list
```

### Hermes Agent

Добавьте сервер в пользовательский `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  yandex_wordstat:
    command: "npx"
    args: ["-y", "wordstat-mcp-server@latest"]
    env:
      YANDEX_WORDSTAT_API_KEY: "your-api-key"
```

Вариант с IAM-токеном аккаунта Яндекса или федеративного аккаунта:

```yaml
mcp_servers:
  yandex_wordstat:
    command: "npx"
    args: ["-y", "wordstat-mcp-server@latest"]
    env:
      YANDEX_WORDSTAT_IAM_TOKEN: "your-iam-token"
      YANDEX_WORDSTAT_FOLDER_ID: "your-folder-id"
```

Hermes передаёт stdio-серверу только явно перечисленные переменные. Не добавляйте пользовательский
конфиг с credential в репозиторий.

Проверьте подключение командой `hermes mcp test yandex_wordstat`, затем перезапустите Hermes или
выполните `/reload-mcp`. Инструменты будут зарегистрированы с префиксом
`mcp_yandex_wordstat_`. Параллельные вызовы по умолчанию выключены, что помогает контролировать квоту.

## Инструменты

| Инструмент              | Назначение                                                      | Важные параметры                                                  |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `wordstat_top_requests` | Популярные и связанные запросы за последние 30 дней             | `phrase`, `num_phrases` 1–2000, `region_ids`, `devices`           |
| `wordstat_dynamics`     | Дневная, недельная или месячная динамика                        | `phrase`, `period`, `from_date`, `to_date`, `auto_dates`, фильтры |
| `wordstat_regions`      | Частота, доля и affinity index по регионам за последние 30 дней | `phrase`, `region_type`, `limit`, `offset`, `resolve_names`       |
| `wordstat_regions_tree` | Иерархия поддерживаемых регионов                                | `max_depth` 1–20, `root_region_id`                                |
| `wordstat_find_regions` | Локальный поиск ID региона по названию                          | `query`, `limit`, `parent_region_id`, `include_children`          |

Значения `devices`: `all`, `desktop`, `phone`, `tablet`; `all` нельзя сочетать с другими значениями.
В одном запросе допускается до 100 `region_ids`.

`wordstat_find_regions` работает по кэшированному дереву. Он полезен, когда агент знает название региона,
но не его ID. `wordstat_regions` при `resolve_names: true` делает дополнительный бесплатный вызов дерева
только при промахе кэша. Каждая следующая страница `wordstat_regions` заново вызывает платный метод
распределения по регионам, поэтому для полной выборки лучше использовать максимальный `limit`.

### Даты и операторы

`wordstat_dynamics` принимает даты в формате `YYYY-MM-DD`. Если при `auto_dates: true` обе даты
отсутствуют, сервер запрашивает последние 60 завершённых дней, 52 завершённые недели или 12 завершённых
месяцев — в зависимости от детализации. Если отсутствует только одна граница, сервер вычисляет её;
автоматически добавленный `to_date` всегда указывает на последний завершённый период. Явно переданные
границы не сдвигаются. При `auto_dates: false` обязателен только `from_date`; `to_date` можно не задавать.

Дневной диапазон не может превышать 60 дней. Для недельной и месячной детализации Wordstat документирует
диапазон от 3 недель или месяцев до 5 лет; самая ранняя доступная история начинается с января 2018 года.
Неделя задаётся от понедельника до воскресенья, месяц — от первого до последнего дня месяца.

Для дневной динамики разрешены операторы `-`, `!`, `+`, кавычки, `[]`, `()` и `|`; для недельной и
месячной — только `+`. Явные неподдерживаемые операторы для недельной и месячной детализации
отклоняются до платного API-вызова.

### Метаданные результата

Каждый успешный ответ содержит:

- `api_calls` — логические вызовы Wordstat API, включая бесплатное дерево регионов;
- `http_attempts` — все HTTP-попытки, в том числе повторы;
- `billable_calls_estimate` — оценка платных вызовов; финальный биллинг определяет Yandex;
- `local_hourly_budget_remaining` — остаток локального часового лимита или `null`;
- `content_truncated` — был ли сокращён текстовый MCP-контент из-за размера.

Поля `count` и `total_count` возвращаются строками, чтобы не терять точность 64-битных целых.

## Примеры запросов агенту

### Расширение семантики

```text
Подбери запросы по теме «онлайн-курсы английского». Покажи 100 популярных запросов
и похожие запросы за последний месяц. Сгруппируй их по смыслу: обучение, цена,
формат, уровень и бренды. В каждой группе выдели 5 самых популярных фраз.
Популярные и похожие запросы покажи отдельно.
```

### Сравнение регионального спроса

```text
Сравни спрос на «доставка цветов» в Москве и Санкт-Петербурге за последние 12 полных
месяцев. Найди нужные регионы сам. Покажи динамику по месяцам для каждого города,
отметь месяцы с самым высоким и низким спросом и объясни различия в сезонности.
Если каких-то данных нет, не додумывай их.
```

### Интерес по регионам

```text
Покажи, в каких регионах запросом «горнолыжный курорт» интересуются сильнее всего.
Составь два списка: топ-15 регионов по индексу интереса и топ-15 по числу запросов.
Для каждого региона укажи число запросов, долю и индекс интереса. Коротко объясни,
почему списки отличаются. Загружай дополнительные страницы только при необходимости.
```

### Сезонность и сравнение с прошлым годом

```text
Проанализируй спрос на «кондиционер» по России за последние 24 полных календарных месяца,
не включая текущий месяц. Используй регион «Россия» с ID 225 и обязательно задай начало
и конец периода. Сравни каждый месяц с тем же месяцем годом ранее. Покажи изменение
в запросах и процентах, а также начало и пик сезона. Если данных не хватает, перечисли
пропущенные месяцы и сравни только полные пары. Если год назад было ноль запросов,
процентное изменение не рассчитывай.
```

### Различия по устройствам

```text
Сравни спрос на «заказать продукты» с компьютеров, телефонов и планшетов за последние
60 полных дней. Для каждого типа устройства покажи общее число запросов, среднее за день
и его долю среди трёх типов устройств. Сравнивай только даты, которые есть во всех выборках.
Не называй число запросов количеством уникальных пользователей.
```

### Влияние операторов Wordstat

```text
Покажи, как кавычки влияют на статистику запроса «ремонт квартир». Сравни за последние
60 полных дней обычный запрос `ремонт квартир` и запрос в кавычках `"ремонт квартир"`.
Покажи общую частотность каждого варианта, разницу между ними и простыми словами
объясни, что ограничивают кавычки в Wordstat.
```

### Контроль стоимости исследования

```text
Нужно изучить запрос «ипотека»: популярные и похожие запросы, динамику по месяцам
и интерес по регионам. Сначала скажи, сколько платных обращений к Wordstat потребуется,
и дождись моего подтверждения. После исследования покажи фактическое число обращений
и отдельно отметь повторные попытки, если они были.
```

## Конфигурация

| Переменная                             | По умолчанию | Допустимые значения                        |
| -------------------------------------- | -----------: | ------------------------------------------ |
| `YANDEX_WORDSTAT_API_KEY`              |            — | Ровно один из двух credentials             |
| `YANDEX_WORDSTAT_IAM_TOKEN`            |            — | Ровно один из двух credentials             |
| `YANDEX_WORDSTAT_FOLDER_ID`            |            — | До 50 символов; см. условия выше           |
| `YANDEX_WORDSTAT_TIMEOUT_MS`           |      `30000` | `1`–`300000`                               |
| `YANDEX_WORDSTAT_MAX_RETRIES`          |          `2` | `0`–`10`                                   |
| `YANDEX_WORDSTAT_MAX_RPS`              |          `8` | `1`–`10000`                                |
| `YANDEX_WORDSTAT_MAX_RPH`              |        `100` | `0`–`1000000`; `0` отключает лимит         |
| `YANDEX_WORDSTAT_MAX_CONCURRENCY`      |          `4` | `1`–`100`                                  |
| `YANDEX_WORDSTAT_REGIONS_CACHE_TTL_MS` |   `86400000` | `0`–`2592000000`                           |
| `YANDEX_WORDSTAT_LOG_LEVEL`            |      `error` | `silent`, `error`, `warn`, `info`, `debug` |

Лимиты процесса защищают от неожиданного расхода, но не синхронизируются между несколькими процессами
и не заменяют квоты Yandex Cloud. Повторы учитываются в `http_attempts`, но один логический вызов занимает
одну единицу локального RPH-бюджета.

## Ошибки и диагностика

Ошибка инструмента содержит `code`, безопасное `message`, `retryable`, а при наличии — `http_status`,
`retry_after_seconds` и `http_attempts`.

| Симптом                           | Что проверить                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `CONFIGURATION_ERROR`             | Задан ровно один credential; числа находятся в разрешённых диапазонах          |
| HTTP 400 / `VALIDATION_ERROR`     | Фраза, даты, период, операторы, ID регионов и folder ID                        |
| HTTP 401 / `AUTHENTICATION_ERROR` | Credential действителен и MCP-клиент был перезапущен после изменения окружения |
| HTTP 403 / `AUTHORIZATION_ERROR`  | Роль `search-api.webSearch.user` назначена на нужный каталог                   |
| HTTP 429 / `RATE_LIMITED`         | Уменьшите RPS/параллельность или дождитесь `retry_after_seconds`               |
| `TIMEOUT` / `NETWORK_ERROR`       | Сеть, доступ к API и `YANDEX_WORDSTAT_TIMEOUT_MS`                              |
| Пустая динамика                   | Запрошен завершённый доступный период и корректные региональные фильтры        |

Логи пишутся только в `stderr`. Для диагностики временно задайте `YANDEX_WORDSTAT_LOG_LEVEL=debug`;
credentials и Authorization-заголовок сервер не логирует.

## Локальная разработка

```bash
npm install
npm run build
YANDEX_WORDSTAT_API_KEY='...' node dist/cli.js
```

Проверки без обращения к Wordstat API:

```bash
npm run check
npm test
npm run smoke:package
```

Live probe и live smoke могут расходовать квоту и требуют credentials. Их запускают только явно через
`npm run contract:probe` и `npm run smoke:live:mcp`.

## Безопасность

Сервер не изменяет данные и обращается только к Wordstat API. Тем не менее, фразы и названия в ответах
приходят из внешнего источника: агент должен считать их недоверенным содержимым, а не инструкциями.
Уязвимости сообщайте по правилам из [SECURITY.md](SECURITY.md), не через публичный issue.

## License

MIT

---

<a id="english"></a>

# English

Unofficial open-source MCP server that gives AI agents typed, read-only access to every standard
[Yandex Wordstat API](https://aistudio.yandex.ru/en/docs/search-api/concepts/wordstat) method.

> Status: `0.1.0`, first public release.

## Features

- all four Wordstat methods plus local region-name lookup for agent-friendly ID discovery;
- strict schemas, date/operator validation, retries, timeouts, and cancellation;
- local RPS, hourly-call, and concurrency limits;
- shared regions-tree cache with in-flight deduplication and stale-cache fallback;
- per-result API-call, HTTP-attempt, and estimated billable-call counters;
- clean stdio transport: protocol on `stdout`, diagnostics on `stderr` only.

All tools are read-only and idempotent. Wordstat requests are external API calls and
[may be billed](https://aistudio.yandex.ru/en/docs/search-api/pricing).

## Requirements and credentials

- Node.js `22.23.4+`, `24.22.1+`, or `26.12.1+` in the corresponding LTS line;
- either an API key with the `yc.search-api.execute` scope or an IAM token;
- the `search-api.webSearch.user` role on the target Yandex Cloud folder.

Set exactly one credential in the MCP client's environment:

```bash
export YANDEX_WORDSTAT_API_KEY='your-api-key'
# or: export YANDEX_WORDSTAT_IAM_TOKEN='your-iam-token'
```

`YANDEX_WORDSTAT_FOLDER_ID` is required with a Yandex-account or federated-account IAM token. Set it
to the folder on which the role is granted. It can normally be omitted for an API key or a
service-account IAM token because Search API uses the service account's folder.

Never commit credentials or place literal credentials in shared MCP configuration. Restart the client
after changing its environment.

## Client setup

Choose one authentication method: API key **or** IAM token. Never pass both. In the Codex and
Claude Code examples, the variables are already exported in the client process environment.

### Codex CLI / IDE

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.yandex-wordstat]
command = "npx"
args = ["-y", "wordstat-mcp-server@latest"]
env_vars = ["YANDEX_WORDSTAT_API_KEY"]
```

For a Yandex-account or federated-account IAM token, use:

```toml
[mcp_servers.yandex-wordstat]
command = "npx"
args = ["-y", "wordstat-mcp-server@latest"]
env_vars = ["YANDEX_WORDSTAT_IAM_TOKEN", "YANDEX_WORDSTAT_FOLDER_ID"]
```

Run `codex mcp list` to verify the connection. Codex CLI and the IDE share this configuration.

### Claude Code

```bash
claude mcp add-json --scope user yandex-wordstat \
  '{"command":"npx","args":["-y","wordstat-mcp-server@latest"],"env":{"YANDEX_WORDSTAT_API_KEY":"${YANDEX_WORDSTAT_API_KEY}"}}'
claude mcp list
```

Yandex-account or federated-account IAM token variant:

```bash
claude mcp add-json --scope user yandex-wordstat \
  '{"command":"npx","args":["-y","wordstat-mcp-server@latest"],"env":{"YANDEX_WORDSTAT_IAM_TOKEN":"${YANDEX_WORDSTAT_IAM_TOKEN}","YANDEX_WORDSTAT_FOLDER_ID":"${YANDEX_WORDSTAT_FOLDER_ID}"}}'
claude mcp list
```

### Hermes Agent

Add the server to the user-level `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  yandex_wordstat:
    command: "npx"
    args: ["-y", "wordstat-mcp-server@latest"]
    env:
      YANDEX_WORDSTAT_API_KEY: "your-api-key"
```

Yandex-account or federated-account IAM token variant:

```yaml
mcp_servers:
  yandex_wordstat:
    command: "npx"
    args: ["-y", "wordstat-mcp-server@latest"]
    env:
      YANDEX_WORDSTAT_IAM_TOKEN: "your-iam-token"
      YANDEX_WORDSTAT_FOLDER_ID: "your-folder-id"
```

Hermes passes only explicitly listed variables to a stdio server. Do not commit a user configuration
containing credentials.

Run `hermes mcp test yandex_wordstat`, then restart Hermes or use `/reload-mcp`. Hermes registers the
tools with the `mcp_yandex_wordstat_` prefix. Parallel tool calls stay disabled by default, helping to
keep API usage under control.

## Tools

| Tool                    | Purpose                                                         | Main inputs                                      |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| `wordstat_top_requests` | Popular and associated requests for the last 30 days            | phrase, count, regions, devices                  |
| `wordstat_dynamics`     | Daily, weekly, or monthly demand dynamics                       | phrase, period, date range, regions, devices     |
| `wordstat_regions`      | Count, share, and affinity index by region for the last 30 days | phrase, region type, pagination, name resolution |
| `wordstat_regions_tree` | Supported region hierarchy                                      | depth and optional root region                   |
| `wordstat_find_regions` | Local region-name-to-ID search                                  | query, optional parent, optional children        |

Devices are `all`, `desktop`, `phone`, and `tablet`; `all` must be used alone. A request can contain at
most 100 region IDs. `wordstat_find_regions` searches the cached tree. With `resolve_names: true`,
`wordstat_regions` may make one additional free regions-tree call on a cache miss. Every additional
`wordstat_regions` page repeats the billable regional-distribution API call, so use the maximum
`limit` when a complete result set is required.

### Dynamics dates and operators

Dates use `YYYY-MM-DD`. When both bounds are absent and `auto_dates: true`, the server requests the last
60 complete days, 52 complete weeks, or 12 complete months, depending on granularity. If exactly one
bound is absent, the server calculates it; an automatically added `to_date` always ends on the latest
complete period. Explicit bounds are never shifted. With `auto_dates: false`, only `from_date` is
required; `to_date` may be omitted.

A daily range cannot exceed 60 days. For weekly and monthly detail, Wordstat documents a range from
3 weeks or months up to 5 years, with the earliest available history starting in January 2018. Weeks
run Monday through Sunday, and months from their first through their last calendar day.

Daily dynamics supports `-`, `!`, `+`, quotes, `[]`, `()`, and `|`; weekly and monthly dynamics support
only `+`. Explicitly unsupported operators for weekly and monthly detail are rejected before a
billable API call.

### Result metadata

Every successful result includes:

- `api_calls`: logical Wordstat calls, including the free regions-tree method;
- `http_attempts`: all HTTP attempts, including retries;
- `billable_calls_estimate`: an estimate; Yandex billing is authoritative;
- `local_hourly_budget_remaining`: remaining process-local hourly budget, or `null`;
- `content_truncated`: whether textual MCP content was shortened because of its size.

Counts are strings to preserve 64-bit integer precision.

## Agent prompt examples

### Semantic expansion

```text
Build a keyword set for "online English courses". Show 100 popular requests and related
requests for the last month. Group them by intent: learning, price, format, level, and brand.
Highlight the five most popular phrases in every group. Keep popular and related requests separate.
```

### Regional demand comparison

```text
Compare demand for "flower delivery" in Moscow and Saint Petersburg over the last 12 complete
months. Find the correct regions yourself. Show monthly dynamics for each city, highlight the
highest and lowest months, and explain differences in seasonality. Do not invent missing data.
```

### Regional interest

```text
Show where interest in "ski resort" is strongest. Create two lists: the top 15 regions by
affinity index and the top 15 by request count. Include count, share, and affinity index for
each region. Briefly explain why the lists differ. Load additional pages only when necessary.
```

### Seasonality and comparison with last year

```text
Analyze demand for "air conditioner" in Russia over the last 24 complete calendar months,
excluding the current month. Use Russia region ID 225 and explicitly set the start and end dates.
Compare every month with the same month one year earlier. Show the change in requests and percent,
and identify the start and peak of the season. If data is missing, list the missing months and
compare only complete pairs. If the earlier value is zero, do not calculate a percentage change.
```

### Device differences

```text
Compare demand for "grocery delivery" on desktop, phone, and tablet over the last 60 complete
days. For each device, show the total request count, daily average, and its share among the three
device types. Compare only dates present in every result. Do not call request counts unique users.
```

### Wordstat operator impact

```text
Show how quotation marks affect statistics for "apartment renovation". Over the last 60 complete
days, compare the plain query `apartment renovation` with `"apartment renovation"`. Show the total
count for each, the difference between them, and explain in simple terms what quotes restrict.
```

### Research cost control

```text
Research "mortgage": popular and related requests, monthly dynamics, and regional interest.
First tell me how many billable Wordstat calls this will require and wait for confirmation.
After the research, show the actual number of calls and note any retry attempts separately.
```

## Configuration

| Variable                               |    Default | Range / values                             |
| -------------------------------------- | ---------: | ------------------------------------------ |
| `YANDEX_WORDSTAT_API_KEY`              |          — | Exactly one credential                     |
| `YANDEX_WORDSTAT_IAM_TOKEN`            |          — | Exactly one credential                     |
| `YANDEX_WORDSTAT_FOLDER_ID`            |          — | Up to 50 characters; see above             |
| `YANDEX_WORDSTAT_TIMEOUT_MS`           |    `30000` | `1`–`300000`                               |
| `YANDEX_WORDSTAT_MAX_RETRIES`          |        `2` | `0`–`10`                                   |
| `YANDEX_WORDSTAT_MAX_RPS`              |        `8` | `1`–`10000`                                |
| `YANDEX_WORDSTAT_MAX_RPH`              |      `100` | `0`–`1000000`; `0` disables it             |
| `YANDEX_WORDSTAT_MAX_CONCURRENCY`      |        `4` | `1`–`100`                                  |
| `YANDEX_WORDSTAT_REGIONS_CACHE_TTL_MS` | `86400000` | `0`–`2592000000`                           |
| `YANDEX_WORDSTAT_LOG_LEVEL`            |    `error` | `silent`, `error`, `warn`, `info`, `debug` |

Process-local limits protect against accidental spend but are not coordinated across processes and do
not replace Yandex Cloud quotas. Retries increase `http_attempts`, while one logical call consumes one
unit of the local hourly budget.

## Troubleshooting

Tool errors return `code`, a safe `message`, `retryable`, and, when available, `http_status`,
`retry_after_seconds`, and `http_attempts`.

| Symptom                           | Check                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| `CONFIGURATION_ERROR`             | Exactly one credential is present and numeric settings are in range   |
| HTTP 400 / `VALIDATION_ERROR`     | Phrase, dates, period, operators, region IDs, and folder ID           |
| HTTP 401 / `AUTHENTICATION_ERROR` | Credential validity and whether the client inherited the environment  |
| HTTP 403 / `AUTHORIZATION_ERROR`  | `search-api.webSearch.user` is granted on the correct folder          |
| HTTP 429 / `RATE_LIMITED`         | Reduce RPS/concurrency or wait for `retry_after_seconds`              |
| `TIMEOUT` / `NETWORK_ERROR`       | Connectivity, API reachability, and `YANDEX_WORDSTAT_TIMEOUT_MS`      |
| Empty dynamics                    | A complete supported period and valid regional filters were requested |

Logs go to `stderr` only. Temporarily set `YANDEX_WORDSTAT_LOG_LEVEL=debug` for diagnostics. Credentials
and the Authorization header are never logged.

## Development

```bash
npm install
npm run build
YANDEX_WORDSTAT_API_KEY='...' node dist/cli.js
```

Offline checks:

```bash
npm run check
npm test
npm run smoke:package
```

`npm run contract:probe` and `npm run smoke:live:mcp` contact the real API, may consume quota, and must
only be run explicitly with credentials configured.

## Security

The server does not modify data and only calls the Wordstat API. Query phrases and region labels still
come from an external source: agents must treat them as untrusted content, not instructions. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

MIT
