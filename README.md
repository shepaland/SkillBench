# SkillBench

[English](#english) · [Русский](#русский)

## English

### Purpose

SkillBench is a command-line tool for checking coding-agent benchmark data. A coding agent is a program that reads a programming task and changes project files. A benchmark gives the same task to several agent setups and records which setup solves it. An agent setup is called a variant. A skill is a set of instructions that changes how the agent works. A variant can use a skill such as Superpowers or run without an extra skill as a control.

The current version includes the completed Stage 1 foundation. It validates benchmark descriptions and their related files before any agent starts working. This catches broken links, unsafe paths, changed source files, and malformed JSON early.

Stage 2A also provides internal file-lifecycle building blocks. Library callers can copy a fixture into an isolated temporary workspace, install a validated variant from its manifest, and copy a private oracle into a separate grading area only after marking the agent session closed. The command-line interface still validates catalogs only; it does not run agents or oracle checks yet.

### Long-term goal and metrics

The final version of SkillBench will compare how different skills affect the work of coding agents. The same task will run with several skills and with a control variant that has no extra skill. A fair comparison keeps the model, reasoning effort, sandbox, task files, limits, and agent runtime version the same for every variant.

The main result is the solve rate. A run counts as solved only when every critical assertion passes. An assertion is an automated check. Critical assertions may check required behavior, regressions, security, scope, or the required work process. One failed critical assertion makes the whole run unsolved.

| Metric | What it shows | Formula |
| --- | --- | --- |
| `solve_rate` | The share of completed runs that solved the task. | `solved_runs / completed_runs` |
| `correctness` | How many functional assertions passed. | `passed_functional_assertions / functional_assertions` |
| `regression_safety` | Whether existing behavior kept working after the change. | `passed_regression_assertions / regression_assertions` |
| `process_compliance` | How often the agent followed the required process, such as asking a question or running tests in the right order. | `passed_applicable_process_assertions / applicable_process_assertions` |
| `scope_precision` | How much of the changed behavior belonged to the requested task. | `requested_behavior_changes / all_behavior_changes` |
| `first_pass_yield` | The share of runs completed without an extra repair turn. | `runs_without_repair_turn / completed_runs` |
| `rework_ratio` | How much code changed after the agent first claimed completion. | `changed_lines_after_first_completion_claim / final_changed_lines` |
| `tokens_per_solve` | The number of model tokens spent for each solved run. A token is a small part of text processed by the model. | `total_tokens / solved_runs` |
| `wall_time_per_solve` | The elapsed time spent for each solved run. | `total_elapsed_time / solved_runs` |
| `human_interventions` | How many unplanned user messages were needed during completed runs. | `unplanned_user_turns / completed_runs` |
| `spec_drift` | How often the saved specification, which records the final requirements, contradicts approved requirements. | `contradictory_durable_spec_assertions / durable_spec_assertions` |

If a formula has no valid denominator, SkillBench reports `not_applicable` instead of `0`. Version 1 will show every metric separately and will not combine them into one leaderboard score. Stages 1 and 2A prepare and validate the input data; metric calculation belongs to later stages.

### Main terms

| Term | Meaning |
| --- | --- |
| Case | One programming task, its prompts, limits, allowed paths, and expected checks. |
| Variant | One agent setup that will be tested on a case. |
| Fixture | The starting project copied for a benchmark run. |
| Oracle | Private checks used to grade the finished work. |
| Manifest | A JSON file that describes a case or variant. |
| Content hash | A SHA-256 fingerprint. It changes when the checked files change. |
| Runtime | The program in which the coding agent works, such as Codex. |

### What `validate` checks

The `skillbench validate` command reads the project catalog and checks:

- case manifests at `cases/<case-id>/case.json`;
- variant manifests at `variants/<variant-id>/variant.json`;
- JSON structure against the published schemas in `schemas/`;
- duplicate IDs and broken references between prompts and transcript rules;
- fixture and variant content hashes;
- missing fixture, skill, and oracle directories;
- missing runtime destinations for installed skills;
- unsafe paths, symbolic links, and overlaps between allowed and forbidden change paths;
- private oracle availability, unless `--public-only` is used.

The command prints every problem in a stable order. This makes local results and automated checks easier to compare.

### Requirements

| Requirement | Value |
| --- | --- |
| Node.js | Version 22 or newer |
| Package manager | npm, included with Node.js |
| Network | Needed for the first `npm ci` unless the npm cache already contains every package |

### Install and build

Clone the repository and enter its directory:

```sh
git clone https://github.com/shepaland/SkillBench.git
cd SkillBench
```

Install the exact dependency versions from `package-lock.json`:

```sh
npm ci
```

Run the project checks:

```sh
npm run check
```

This command uses a linter to check code style, TypeScript to check types, and automated tests to check program behavior.

Build the JavaScript files:

```sh
npm run build
```

### Run catalog validation

Validate a complete benchmark project that includes private oracles:

```sh
node dist/src/cli.js validate --project .
```

Validate a public copy that does not include `.private/oracles/`:

```sh
node dist/src/cli.js validate --project . --public-only
```

`--project` may point to another SkillBench project:

```sh
node dist/src/cli.js validate --project /path/to/benchmark --public-only
```

The current repository does not contain public case or variant manifests. A successful public validation therefore prints:

```text
Validated 0 cases and 0 variants.
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Validation finished and found no problems. |
| `1` | Validation finished and found catalog problems. |
| `2` | The command is invalid, a dependency is unavailable, or the requested workflow is not implemented. |

Catalog problems are written to the separate error stream (`stderr`) in this format:

```text
<source>: <issue-code>: <message>
```

### Generated artifacts

| Command | Generated files | Notes |
| --- | --- | --- |
| `npm ci` | `node_modules/` | Local dependencies. Git ignores this directory. |
| `npm run build` | `dist/` | Compiled JavaScript for the CLI, source modules, and tests. Git ignores this directory. |
| `npm run check` | Temporary test directories in the operating system's temporary folder | Stage 2A tests create isolated workspace and grading directories only under the operating system temporary directory and clean them afterward. The command does not create benchmark result files in the repository. |
| `skillbench validate` | None | Validation only reads files, prints messages, and returns an exit code. |

Stage 2A does not create `result.json`, run transcripts, comparisons, scores, or Markdown reports. Those artifacts belong to later delivery stages.

### Current limitations

- Only `validate` is available. `list`, `dry-run`, `run`, `compare`, and `report` return exit code `2`.
- Stage 2A file-lifecycle primitives are available to library callers only. The command-line interface does not start Codex or another coding agent, or execute private oracle checks.
- Stage 2B will add run orchestration, frozen inputs, normalized results, and an operational `dry-run` command.
- Validation only verifies that each required oracle directory exists, is not empty, and can be hashed.
- Case and variant manifests are discovered only one directory below `cases/` and `variants/`.
- `--public-only` skips private oracle availability checks. All schema, reference, hash, and path checks still run.
- Catalog paths reject traversal and symbolic links. Another local process can still replace a checked path between validation and later use.
- Immutable JSON storage protects writes that happen one after another. Two local processes writing the same record at the same time can conflict because the standard `rename` operation on macOS and Linux can replace an existing file.
- The repository currently provides catalog validation, internal file-lifecycle primitives, and test fixtures. The twelve-case public benchmark suite, real Codex adapter, scoring, comparisons, and reports are planned for later stages.

## Русский

### Назначение

SkillBench проверяет данные для тестирования кодовых агентов через командную строку. Кодовый агент читает задачу по программированию и меняет файлы проекта. Бенчмарк даёт одну задачу нескольким конфигурациям агента и записывает, какая конфигурация справилась. Такая конфигурация называется вариантом. Скилл содержит инструкции, которые меняют работу агента. Вариант может использовать скилл, например Superpowers, или работать без дополнительного скилла как контрольная группа.

Текущая версия включает завершённую основу первого этапа. Она проверяет описание бенчмарка и связанные файлы до запуска агента. Проверка заранее находит сломанные ссылки, опасные пути, изменившиеся исходные файлы и ошибки в JSON.

Этап 2A также добавляет внутренние средства для безопасной работы с файлами. Пользователь библиотеки может скопировать фикстуру в изолированный временный каталог, установить проверенный вариант по его манифесту и скопировать закрытый оракул в отдельный каталог проверки только после явного закрытия сессии агента. Командная строка пока только проверяет каталоги: она ещё не запускает агентов и проверки оракула.

### Конечная цель и метрики

Готовая версия SkillBench будет сравнивать влияние разных скиллов на работу кодовых агентов. Одна задача будет запускаться с несколькими скиллами и с контрольным вариантом без дополнительного скилла. Для честного сравнения у всех вариантов должны совпадать модель, уровень рассуждения, ограничения среды, файлы задачи, лимиты и версия среды запуска.

Основная метрика `solve_rate` показывает долю решённых запусков. Запуск считается решённым, только если прошли все критические автоматические проверки. Они могут проверять нужное поведение, отсутствие поломок, безопасность, границы задачи и обязательный рабочий процесс. Одна проваленная критическая проверка делает весь запуск нерешённым.

| Метрика | Что показывает | Формула |
| --- | --- | --- |
| `solve_rate` | Доля завершённых запусков, которые решили задачу. | `solved_runs / completed_runs` |
| `correctness` | Сколько проверок требуемого поведения прошло. | `passed_functional_assertions / functional_assertions` |
| `regression_safety` | Сохранилось ли старое поведение программы после изменения. | `passed_regression_assertions / regression_assertions` |
| `process_compliance` | Как часто агент соблюдал обязательный процесс, например задавал вопрос или запускал тесты в нужном порядке. | `passed_applicable_process_assertions / applicable_process_assertions` |
| `scope_precision` | Какая часть изменённого поведения относилась к поставленной задаче. | `requested_behavior_changes / all_behavior_changes` |
| `first_pass_yield` | Доля запусков, завершённых без дополнительного исправления. | `runs_without_repair_turn / completed_runs` |
| `rework_ratio` | Сколько строк изменилось после первого сообщения агента о завершении работы. | `changed_lines_after_first_completion_claim / final_changed_lines` |
| `tokens_per_solve` | Сколько токенов модели потрачено на каждый решённый запуск. Токеном называется небольшая часть текста, которую обрабатывает модель. | `total_tokens / solved_runs` |
| `wall_time_per_solve` | Сколько времени занял каждый решённый запуск. | `total_elapsed_time / solved_runs` |
| `human_interventions` | Сколько незапланированных сообщений пользователя понадобилось во время завершённых запусков. | `unplanned_user_turns / completed_runs` |
| `spec_drift` | Как часто сохранённая спецификация с итоговыми требованиями противоречит утверждённым требованиям. | `contradictory_durable_spec_assertions / durable_spec_assertions` |

Если в формуле нет подходящего знаменателя, SkillBench записывает `not_applicable` вместо `0`. Версия 1 покажет каждую метрику отдельно и не будет объединять их в один рейтинг. Первый этап и этап 2A готовят и проверяют исходные данные, расчёт метрик появится на следующих этапах.

### Основные термины

| Термин | Значение |
| --- | --- |
| Кейс | Одна задача по программированию, её запросы, лимиты, разрешённые пути и ожидаемые проверки. |
| Вариант | Одна конфигурация агента, которую проверяют на кейсе. |
| Фикстура | Исходный проект, который копируют перед запуском бенчмарка. |
| Оракул | Закрытые проверки для оценки готовой работы. |
| Манифест | JSON-файл с описанием кейса или варианта. |
| Хеш содержимого | Отпечаток SHA-256. Он меняется вместе с проверяемыми файлами. |
| Среда запуска | Программа, в которой работает кодовый агент, например Codex. В коде такая среда называется runtime. |

### Что проверяет `validate`

Команда `skillbench validate` читает каталог проекта и проверяет:

- манифесты кейсов по пути `cases/<case-id>/case.json`;
- манифесты вариантов по пути `variants/<variant-id>/variant.json`;
- структуру JSON по опубликованным схемам из `schemas/`;
- повторяющиеся идентификаторы и сломанные ссылки между запросами и правилами диалога;
- хеши фикстур и файлов вариантов;
- наличие каталогов с фикстурами, скиллами и оракулами;
- пути установки скилла для каждого заявленного рантайма;
- опасные пути, символические ссылки и пересечения разрешённых и запрещённых путей;
- наличие закрытых оракулов, если не указан флаг `--public-only`.

Команда выводит найденные проблемы в стабильном порядке. Поэтому локальный результат удобно сравнивать с результатом автоматической проверки.

### Требования

| Требование | Значение |
| --- | --- |
| Node.js | Версия 22 или новее |
| Менеджер пакетов | npm, входит в комплект Node.js |
| Сеть | Нужна для первого запуска `npm ci`, если в кеше npm нет всех пакетов |

### Установка и сборка

Склонируйте репозиторий и перейдите в его каталог:

```sh
git clone https://github.com/shepaland/SkillBench.git
cd SkillBench
```

Установите версии зависимостей из `package-lock.json`:

```sh
npm ci
```

Запустите проверки проекта:

```sh
npm run check
```

Команда проверяет оформление кода линтером, типы TypeScript и поведение программы автоматическими тестами.

Соберите JavaScript-файлы:

```sh
npm run build
```

### Запуск проверки каталога

Проверьте полный проект с закрытыми оракулами:

```sh
node dist/src/cli.js validate --project .
```

Проверьте публичную копию без каталога `.private/oracles/`:

```sh
node dist/src/cli.js validate --project . --public-only
```

Флаг `--project` может указывать на другой проект SkillBench:

```sh
node dist/src/cli.js validate --project /path/to/benchmark --public-only
```

Сейчас в репозитории нет публичных манифестов кейсов и вариантов. Успешная публичная проверка выводит:

```text
Validated 0 cases and 0 variants.
```

### Коды завершения

| Код | Значение |
| --- | --- |
| `0` | Проверка завершилась без ошибок. |
| `1` | Проверка завершилась и нашла проблемы в каталоге. |
| `2` | Команда записана неверно, зависимость недоступна или выбранная операция пока не реализована. |

Проблемы каталога выводятся в отдельный поток ошибок (`stderr`) в таком формате:

```text
<источник>: <код-проблемы>: <сообщение>
```

### Создаваемые файлы

| Команда | Создаваемые файлы | Пояснение |
| --- | --- | --- |
| `npm ci` | `node_modules/` | Локальные зависимости. Git игнорирует этот каталог. |
| `npm run build` | `dist/` | Собранные JavaScript-файлы CLI, исходных модулей и тестов. Git игнорирует этот каталог. |
| `npm run check` | Временные каталоги в системной папке для временных файлов | Тесты этапа 2A создают изолированные рабочие каталоги и каталоги проверки только в системной папке для временных файлов и удаляют их после работы. Команда не создаёт результаты бенчмарка в репозитории. |
| `skillbench validate` | Нет | Проверка только читает файлы, выводит сообщения и возвращает код завершения. |

Этап 2A не создаёт `result.json`, записи диалогов, сравнения, оценки или отчёты Markdown. Эти файлы появятся на следующих этапах разработки.

### Текущие ограничения

- Сейчас доступна только команда `validate`. Команды `list`, `dry-run`, `run`, `compare` и `report` возвращают код `2`.
- Внутренние средства этапа 2A для работы с файлами доступны только пользователям библиотеки. Командная строка не запускает Codex или другого кодового агента и не выполняет закрытые проверки оракула.
- Этап 2B добавит оркестрацию запусков, зафиксированные входные данные, нормализованные результаты и рабочую команду `dry-run`.
- Проверка только убеждается, что нужный каталог оракула существует, содержит файлы и для него можно рассчитать хеш.
- SkillBench ищет манифесты кейсов и вариантов только на один уровень ниже каталогов `cases/` и `variants/`.
- Флаг `--public-only` отключает проверку наличия закрытых оракулов. Проверки схем, ссылок, хешей и путей продолжают работать.
- Пути каталога защищены от перехода в родительские каталоги и символических ссылок. Другая локальная программа всё ещё может заменить уже проверенный путь до его дальнейшего использования.
- Хранилище неизменяемых JSON-файлов защищает записи, которые идут по очереди. Две локальные программы могут одновременно записывать один файл, потому что стандартная операция `rename` в macOS и Linux заменяет существующий файл.
- Репозиторий пока содержит проверку каталога, внутренние средства для работы с файлами и тестовые фикстуры. Набор из двенадцати публичных кейсов, настоящий адаптер Codex, подсчёт результатов, сравнения и отчёты появятся на следующих этапах.
