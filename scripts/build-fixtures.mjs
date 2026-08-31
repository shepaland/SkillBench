#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const FIXTURES = "fixtures";
const OVERLAYS = "overlays";

async function main(argv) {
  const options = parseOptions(argv);
  const overlaysDirectory = join(options.root, FIXTURES, OVERLAYS);
  const names = await listOverlayNames(overlaysDirectory);

  for (const name of names) {
    const overlay = await readOverlay(options.root, name);
    const { staging, composed } = await compose(options.root, overlay);
    try {
      if (options.check) {
        await verify(options.root, overlay, composed);
      } else {
        const target = join(options.root, FIXTURES, overlay.target);
        await rm(target, { recursive: true, force: true });
        await cp(composed, target, { recursive: true, dereference: false, verbatimSymlinks: true });
        process.stdout.write(`composed ${FIXTURES}/${overlay.target}\n`);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if (options.check) {
    process.stdout.write(`verified ${String(names.length)} composed fixtures\n`);
  }
}

async function listOverlayNames(overlaysDirectory) {
  let entries;
  try {
    entries = await readdir(overlaysDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseOptions(argv) {
  const options = { root: process.cwd(), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") {
      options.check = true;
      continue;
    }
    if (argv[index] === "--root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--root needs a directory");
      }
      options.root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

async function readOverlay(root, name) {
  const directory = join(root, FIXTURES, OVERLAYS, name);
  const manifest = JSON.parse(await readFile(join(directory, "overlay.json"), "utf8"));
  for (const field of ["baseFixture", "target", "description"]) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") {
      throw new Error(`overlay ${name} has no ${field}`);
    }
  }
  const removals = manifest.removals ?? [];
  if (!Array.isArray(removals) || removals.some((entry) => typeof entry !== "string")) {
    throw new Error(`overlay ${name} has a malformed removals list`);
  }
  assertInsideFixtures(root, manifest.baseFixture, `overlay ${name} base`);
  assertInsideFixtures(root, manifest.target, `overlay ${name} target`);
  return { name, directory, ...manifest, removals };
}

function assertInsideFixtures(root, candidate, label) {
  const fixtures = join(root, FIXTURES);
  const resolved = resolve(fixtures, candidate);
  const inside = resolved.startsWith(fixtures + sep) && relative(fixtures, resolved).split(sep).length === 1;
  if (!inside) {
    throw new Error(`${label} must name one directory inside ${FIXTURES}/: ${candidate}`);
  }
}

function assertInsideDirectory(root, candidate, label) {
  const resolved = resolve(root, candidate);
  if (!resolved.startsWith(root + sep)) {
    throw new Error(`${label} must stay inside its fixture: ${candidate}`);
  }
}

async function compose(root, overlay) {
  const base = join(root, FIXTURES, overlay.baseFixture);
  if (!(await isDirectory(base))) {
    throw new Error(`overlay ${overlay.name} names a missing base fixture: ${overlay.baseFixture}`);
  }
  await assertNoSymbolicLinks(base, overlay.baseFixture);

  const files = join(overlay.directory, "files");
  if (!(await isDirectory(files))) {
    throw new Error(`overlay ${overlay.name} has no files directory`);
  }
  await assertNoSymbolicLinks(files, `overlay ${overlay.name}`);

  const staging = await mkdtemp(join(tmpdir(), "skillbench-compose-"));
  try {
    const composed = join(staging, overlay.target);
    await mkdir(composed, { recursive: true });
    await cp(base, composed, { recursive: true, dereference: false, verbatimSymlinks: true });

    for (const removal of overlay.removals) {
      assertInsideDirectory(composed, removal, `overlay ${overlay.name} removal`);
    }
    for (const removal of overlay.removals) {
      const target = join(composed, removal);
      if (!(await exists(target))) {
        throw new Error(`overlay ${overlay.name} removes a path that the base does not have: ${removal}`);
      }
      await rm(target, { recursive: true });
    }

    await cp(files, composed, { recursive: true, dereference: false, verbatimSymlinks: true });
    return { staging, composed };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function verify(root, overlay, composed) {
  const target = join(root, FIXTURES, overlay.target);
  if (!(await isDirectory(target))) {
    throw new Error(`composed fixture ${FIXTURES}/${overlay.target} is missing; run npm run fixtures:build`);
  }
  const expected = await listFiles(composed);
  const actual = await listFiles(target);

  for (const path of new Set([...expected.keys(), ...actual.keys()])) {
    const left = expected.get(path);
    const right = actual.get(path);
    if (left === undefined) {
      throw new Error(`${FIXTURES}/${overlay.target}/${path} is not produced by its overlay; run npm run fixtures:build`);
    }
    if (right === undefined) {
      throw new Error(`${FIXTURES}/${overlay.target}/${path} is missing; run npm run fixtures:build`);
    }
    if (!left.equals(right)) {
      throw new Error(`${FIXTURES}/${overlay.target}/${path} differs from its overlay; run npm run fixtures:build`);
    }
  }
}

async function listFiles(root, prefix = "", collected = new Map()) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await listFiles(root, relativePath, collected);
      continue;
    }
    collected.set(relativePath, await readFile(join(root, relativePath)));
  }
  return collected;
}

async function assertNoSymbolicLinks(root, label, prefix = "") {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const status = await lstat(join(root, relativePath));
    if (status.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${relativePath}`);
    }
    if (status.isDirectory()) {
      await assertNoSymbolicLinks(root, label, relativePath);
    }
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`build-fixtures: ${error.message}\n`);
  process.exitCode = 1;
});
