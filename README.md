# SkillBench

[English](#english) · [Русский](#русский)

## English

### Purpose

SkillBench is a command-line tool for checking coding-agent benchmark data. A coding agent is a program that reads a programming task and changes project files. A benchmark gives the same task to several agent setups and records which setup solves it. An agent setup is called a variant. A skill is a set of instructions that changes how the agent works. A variant can use a skill such as Superpowers or run without an extra skill as a control.

The current version has four working commands. `validate` checks a benchmark catalog for broken links, unsafe paths, changed source files, and malformed JSON before any agent starts working. `list` prints the cases and variants found in a project. `dry-run` freezes every input needed for a run — such as the case, the variant, the model, and the sandbox mode — and prints the resulting plan without copying a workspace or starting an agent. `run` executes one or more independent runs from start to finish against a deterministic built-in fake runtime.

No live coding agent is connected yet. Comparing variants, calculating metrics, and generating reports are not implemented. The `compare` and `report` commands are reserved for that future work and currently return exit code `2`.

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

If a formula has no valid denominator, SkillBench reports `not_applicable` instead of `0`. Version 1 will show every metric separately and will not combine them into one leaderboard score. The current version prepares, validates, and executes runs; metric calculation belongs to a later stage.

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

### `list`, `dry-run`, and `run`

`list` prints the cases and variants defined in a project. Add `--json` to get the same information as a JSON document for scripts.

```sh
node dist/src/cli.js list --project .
```

`dry-run` freezes every input needed for one run — the case, the variant, the model, the reasoning effort, the sandbox mode, and content hashes — and prints the resulting plan. It does not copy a workspace or start an agent.

```sh
node dist/src/cli.js dry-run --project . --case <case-id> --variant <variant-id>
```

`run` executes one or more independent runs from start to finish: it copies the fixture into an isolated workspace, installs the variant, runs the coding agent through the deterministic fake runtime, checks the result against the private oracle, and writes the evidence to disk. `--runs` sets how many independent repetitions to execute.

```sh
node dist/src/cli.js run --project . --case <case-id> --variant <variant-id> --runs 2
```

### Run evidence

Each run writes its evidence under `runs/<case-id>/<variant-id>/<run-id>/` as four files:

| File | Contents |
| --- | --- |
| `manifest.json` | The frozen run inputs: case, variant, model, sandbox mode, limits, and content hashes. |
| `transcript.json` | The events, process result, and token usage reported by the runtime. |
| `changes.json` | The files the agent added, changed, or removed, and whether any change fell outside the allowed paths. |
| `result.json` | The run status, the outcome of each assertion, and the run's costs. |

### Run statuses

| Status | Meaning |
| --- | --- |
| `completed` | The run finished normally. |
| `exhausted` | The agent hit a limit, such as the wall-clock time or token limit. Later metrics will count this as an unsolved run. |
| `errored` | The tool itself failed, for example while copying files. Later metrics will exclude this run instead of counting it as unsolved. |

### Private oracle manifest

Each case's private grading checks live in `.private/oracles/<case-id>/oracle.json`. Its JSON structure is published as `schemas/oracle.schema.json`, so anyone can see the required shape without reading the private content itself. Every check in the manifest maps one declared assertion to one typed command, together with the working directory to run it in and a timeout in milliseconds. Unless `--public-only` is used, `validate` loads this manifest and confirms it covers exactly the assertions declared in the case — no assertion left without a check, no check for an assertion the case does not declare, and no two checks naming the same assertion.

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
| `0` | The command finished and everything it checked passed. |
| `1` | The command finished and found problems with what it checked. `validate` found catalog problems; `run` finished without solving the case, either because a critical check failed or because the agent ran out of its limits. |
| `2` | The command could not do its work: the command line was wrong, an unknown case or variant was given, a dependency was missing or broken (such as the private oracle), or a run failed because the tool itself broke. |

Catalog problems are written to the separate error stream (`stderr`) in this format:

```text
<source>: <issue-code>: <message>
```

### Generated artifacts

| Command | Generated files | Notes |
| --- | --- | --- |
| `npm ci` | `node_modules/` | Local dependencies. Git ignores this directory. |
| `npm run build` | `dist/` | Compiled JavaScript for the CLI, source modules, and tests. Git ignores this directory. |
| `npm run check` | Temporary test directories in the operating system's temporary folder | Tests create isolated workspace and grading directories only under the operating system temporary directory and clean them afterward. The command does not create benchmark result files in the repository. |
| `skillbench validate` | None | Validation only reads files, prints messages, and returns an exit code. |
| `skillbench list` | None | Listing only reads the catalog and prints it. |
| `skillbench dry-run` | None | The plan is printed only; no workspace is copied and no files are written. |
| `skillbench run` | `runs/<case-id>/<variant-id>/<run-id>/` | Each run writes its manifest, transcript, changes, and result there. Git ignores the `runs/` directory. |

Comparisons and Markdown reports are not implemented yet. Those artifacts belong to a later delivery stage.

### Current limitations

- `compare` and `report` are reserved commands and return exit code `2`.
- `run` executes against the deterministic built-in fake runtime only. No live coding agent, such as Codex, is connected yet.
- Runs execute one after another, not in parallel.
- The fake runtime plays back a scripted transcript and does not change any files in the workspace, so an end-to-end run exercises the pipeline rather than real agent behavior.
- `validate` checks that each required private oracle directory exists, is not empty, can be hashed, and — unless `--public-only` is used — that its oracle manifest covers exactly the case's declared assertions.
- Case and variant manifests are discovered only one directory below `cases/` and `variants/`.
- `--public-only` skips private oracle availability checks. All schema, reference, hash, and path checks still run.
- Catalog paths reject traversal and symbolic links. Another local process can still replace a checked path between validation and later use.
- Immutable JSON storage protects writes that happen one after another. Two local processes writing the same record at the same time can conflict because the standard `rename` operation on macOS and Linux can replace an existing file.
- The repository currently provides catalog validation, run orchestration against the fake runtime, and test fixtures. The twelve-case public benchmark suite, a real Codex adapter, scoring, comparisons, and reports are planned for later stages.

## Русский

### Назначение

SkillBench проверяет данные для тестирования кодовых агентов через командную строку. Кодовый агент читает задачу по программированию и меняет файлы проекта. Бенчмарк даёт одну задачу нескольким конфигурациям агента и записывает, какая конфигурация справилась. Такая конфигурация называется вариантом. Скилл содержит инструкции, которые меняют работу агента. Вариант может использовать скилл, например Superpowers, или работать без дополнительного скилла как контрольная группа.

Текущая версия имеет четыре рабочие команды. `validate` проверяет каталог бенчмарка: ищет сломанные ссылки, опасные пути, изменившиеся исходные файлы и ошибки в JSON до запуска агента. `list` выводит список кейсов и вариантов, найденных в проекте. `dry-run` фиксирует все входные данные для запуска — например, кейс, вариант, модель и режим песочницы — и печатает получившийся план без копирования рабочего каталога и без запуска агента. `run` выполняет один или несколько независимых запусков от начала до конца на детерминированной встроенной фиктивной среде выполнения.

Настоящий кодовый агент пока не подключён. Сравнение вариантов, расчёт метрик и создание отчётов ещё не реализованы. Команды `compare` и `report` зарезервированы под эту будущую работу и сейчас возвращают код завершения `2`.

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

Если в формуле нет подходящего знаменателя, SkillBench записывает `not_applicable` вместо `0`. Версия 1 покажет каждую метрику отдельно и не будет объединять их в один рейтинг. Текущая версия готовит, проверяет и выполняет запуски; расчёт метрик появится на следующем этапе.

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

### `list`, `dry-run` и `run`

`list` выводит список кейсов и вариантов, заданных в проекте. Добавьте `--json`, чтобы получить те же данные в виде JSON-документа для скриптов.

```sh
node dist/src/cli.js list --project .
```

`dry-run` фиксирует все входные данные для одного запуска — кейс, вариант, модель, уровень рассуждения, режим песочницы и хеши содержимого — и печатает получившийся план. Команда не копирует рабочий каталог и не запускает агента.

```sh
node dist/src/cli.js dry-run --project . --case <case-id> --variant <variant-id>
```

`run` выполняет один или несколько независимых запусков от начала до конца: копирует фикстуру в изолированный рабочий каталог, устанавливает вариант, запускает кодового агента через детерминированную фиктивную среду выполнения, проверяет результат по закрытому оракулу и записывает свидетельства запуска на диск. Флаг `--runs` задаёт число независимых повторов.

```sh
node dist/src/cli.js run --project . --case <case-id> --variant <variant-id> --runs 2
```

### Свидетельства запуска

Каждый запуск записывает свои свидетельства в каталог `runs/<case-id>/<variant-id>/<run-id>/` в виде четырёх файлов:

| Файл | Содержимое |
| --- | --- |
| `manifest.json` | Зафиксированные входные данные запуска: кейс, вариант, модель, режим песочницы, лимиты и хеши содержимого. |
| `transcript.json` | События, результат процесса и расход токенов, о которых сообщила среда выполнения. |
| `changes.json` | Файлы, которые агент добавил, изменил или удалил, и попало ли какое-либо изменение за пределы разрешённых путей. |
| `result.json` | Статус запуска, результат каждой проверки-утверждения и затраты на запуск. |

### Статусы запуска

| Статус | Значение |
| --- | --- |
| `completed` | Запуск завершился обычным образом. |
| `exhausted` | Агент упёрся в лимит, например по времени или по числу токенов. В будущих метриках такой запуск будет считаться нерешённым. |
| `errored` | Отказал сам инструмент, например при копировании файлов. В будущих метриках такой запуск будет исключён, а не засчитан как нерешённый. |

### Манифест закрытого оракула

Закрытые проверки для оценки каждого кейса лежат в `.private/oracles/<case-id>/oracle.json`. Их структура JSON опубликована как `schemas/oracle.schema.json`, поэтому любой может увидеть требуемую форму, не читая само закрытое содержимое. Каждая проверка в манифесте связывает одно заявленное утверждение с одной типизированной командой, вместе с рабочим каталогом для её запуска и таймаутом в миллисекундах. Если не указан флаг `--public-only`, `validate` загружает этот манифест и проверяет, что он покрывает ровно те утверждения, что заявлены в кейсе, — без утверждений без проверки, без проверок для незаявленных утверждений и без двух проверок на одно и то же утверждение.

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
| `0` | Команда завершилась, и всё, что она проверяла, прошло успешно. |
| `1` | Команда завершилась и нашла проблемы в том, что проверяла. `validate` нашла проблемы в каталоге; `run` завершился, не решив задачу, — либо провалилась критическая проверка, либо агент исчерпал свои лимиты. |
| `2` | Команда не смогла выполнить свою работу: неверная командная строка, неизвестный кейс или вариант, отсутствующая или сломанная зависимость (например, закрытый оракул), либо запуск, который прервался из-за поломки самого инструмента. |

Проблемы каталога выводятся в отдельный поток ошибок (`stderr`) в таком формате:

```text
<источник>: <код-проблемы>: <сообщение>
```

### Создаваемые файлы

| Команда | Создаваемые файлы | Пояснение |
| --- | --- | --- |
| `npm ci` | `node_modules/` | Локальные зависимости. Git игнорирует этот каталог. |
| `npm run build` | `dist/` | Собранные JavaScript-файлы CLI, исходных модулей и тестов. Git игнорирует этот каталог. |
| `npm run check` | Временные каталоги в системной папке для временных файлов | Тесты создают изолированные рабочие каталоги и каталоги проверки только в системной папке для временных файлов и удаляют их после работы. Команда не создаёт результаты бенчмарка в репозитории. |
| `skillbench validate` | Нет | Проверка только читает файлы, выводит сообщения и возвращает код завершения. |
| `skillbench list` | Нет | Вывод списка только читает каталог и печатает его. |
| `skillbench dry-run` | Нет | Печатается только план; рабочий каталог не копируется, файлы не записываются. |
| `skillbench run` | `runs/<case-id>/<variant-id>/<run-id>/` | Каждый запуск записывает туда манифест, запись диалога, изменения и результат. Git игнорирует каталог `runs/`. |

Сравнения и отчёты Markdown ещё не реализованы. Эти файлы появятся на следующем этапе разработки.

### Текущие ограничения

- `compare` и `report` — зарезервированные команды, они возвращают код `2`.
- `run` выполняется только на детерминированной встроенной фиктивной среде выполнения. Настоящий кодовый агент, например Codex, пока не подключён.
- Запуски выполняются один за другим, а не параллельно.
- Фиктивная среда выполнения проигрывает заранее написанный сценарий и не меняет файлы в рабочем каталоге, поэтому сквозной запуск проверяет конвейер обработки, а не поведение настоящего агента.
- `validate` проверяет, что нужный каталог закрытого оракула существует, содержит файлы и для него можно рассчитать хеш, а если не указан флаг `--public-only` — что его манифест покрывает ровно заявленные в кейсе утверждения.
- SkillBench ищет манифесты кейсов и вариантов только на один уровень ниже каталогов `cases/` и `variants/`.
- Флаг `--public-only` отключает проверку наличия закрытых оракулов. Проверки схем, ссылок, хешей и путей продолжают работать.
- Пути каталога защищены от перехода в родительские каталоги и символических ссылок. Другая локальная программа всё ещё может заменить уже проверенный путь до его дальнейшего использования.
- Хранилище неизменяемых JSON-файлов защищает записи, которые идут по очереди. Две локальные программы могут одновременно записывать один файл, потому что стандартная операция `rename` в macOS и Linux заменяет существующий файл.
- Репозиторий пока содержит проверку каталога, оркестрацию запусков на фиктивной среде выполнения и тестовые фикстуры. Набор из двенадцати публичных кейсов, настоящий адаптер Codex, подсчёт результатов, сравнения и отчёты появятся на следующих этапах.
