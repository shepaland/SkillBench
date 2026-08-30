# SkillBench

SkillBench evaluates coding skills against repeatable benchmarks. It requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm run build
npm exec skillbench -- validate
```

`skillbench validate` checks schemas, references, hashes, paths, and private oracle availability. It exits with `0` when validation succeeds, `1` when it finds catalog findings, and `2` for invalid invocations, missing dependencies, or unavailable commands.

Use `--public-only` to validate a public checkout that does not include private oracles:

```sh
npm exec skillbench -- validate --public-only
```

This relaxes only private oracle availability; normal benchmark validation remains unchanged.

The remaining v1 interface commands (`list`, `dry-run`, `run`, `compare`, and `report`) are reserved and intentionally return exit code `2` until their delivery stages land.
