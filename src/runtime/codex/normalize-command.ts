export interface CommandRecord {
  readonly executor: string;
  readonly args: readonly string[];
}

const shellFlags = new Set(["-lc", "-c", "-lic"]);

/**
 * Turns one reported command string into command records. The runtime reports a
 * command as text, usually wrapped in a login shell. Nothing here is executed and
 * nothing is expanded: this is a matcher's view of what ran, not a shell.
 */
export function normalizeCommand(command: string): readonly CommandRecord[] {
  const tokens = tokenize(command);
  if (tokens.length === 0) return Object.freeze([]);

  const script = unwrapShell(tokens);
  if (script === undefined) {
    return Object.freeze([record(tokens)].filter(isRecord));
  }

  const records: CommandRecord[] = [];
  for (const segment of script.split(/&&|\|\||;|\||\n/u)) {
    const built = record(tokenize(segment));
    if (built !== undefined) records.push(built);
  }
  return Object.freeze(records);
}

function unwrapShell(tokens: readonly string[]): string | undefined {
  const [executable, flag, script] = tokens;
  if (executable === undefined || flag === undefined || script === undefined) return undefined;
  if (tokens.length !== 3 || !shellFlags.has(flag)) return undefined;
  return script;
}

function record(tokens: readonly string[]): CommandRecord | undefined {
  const [executor, ...args] = tokens;
  if (executor === undefined) return undefined;
  return Object.freeze({ executor, args: Object.freeze(args) });
}

function isRecord(value: CommandRecord | undefined): value is CommandRecord {
  return value !== undefined;
}

function tokenize(text: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const character of text) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  if (current !== "") tokens.push(current);
  return tokens;
}
