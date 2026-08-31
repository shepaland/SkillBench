import type { CommandMatcher, TranscriptRule } from "../domain/model.js";
import type { TranscriptEvent } from "../runtime/runtime-adapter.js";

export interface TranscriptRuleOutcome {
  readonly ruleId: string;
  /** Whether the check itself holds, before `expect` is applied. */
  readonly held: boolean;
  /** Whether the rule is satisfied: `held` equals the expected value. */
  readonly satisfied: boolean;
  readonly detail: string;
}

export function evaluateRules(
  rules: readonly TranscriptRule[],
  events: readonly TranscriptEvent[],
): readonly TranscriptRuleOutcome[] {
  return Object.freeze(rules.map((rule) => evaluateRule(rule, events)));
}

export function evaluateRule(
  rule: TranscriptRule,
  events: readonly TranscriptEvent[],
): TranscriptRuleOutcome {
  const held = holds(rule, events);
  const expected = rule.expect ?? true;
  return Object.freeze({
    ruleId: rule.id,
    held,
    satisfied: held === expected,
    detail: `${rule.check} ${held ? "held" : "did not hold"}; expected ${expected ? "true" : "false"}`,
  });
}

function holds(rule: TranscriptRule, events: readonly TranscriptEvent[]): boolean {
  switch (rule.check) {
    case "no_file_change":
      return firstChangeIndex(events) === -1;
    case "assistant_message":
      return events.some((event) => event.type === "assistant_message");
    case "command_ran":
      return firstCommandIndex(events, rule) !== -1;
    case "command_before_file_change": {
      const command = firstCommandIndex(events, rule);
      if (command === -1) return false;
      const change = firstChangeIndex(events);
      return change === -1 || command < change;
    }
    case "command_after_file_change": {
      const command = lastCommandIndex(events, rule);
      if (command === -1) return false;
      const change = lastChangeIndex(events);
      return change === -1 || command > change;
    }
  }
}

function matchesCommand(event: TranscriptEvent, matcher: CommandMatcher): boolean {
  return event.type === "command" &&
    event.executor === matcher.executor &&
    matcher.argsPrefix.every((argument, index) => event.args[index] === argument);
}

function firstCommandIndex(events: readonly TranscriptEvent[], matcher: CommandMatcher): number {
  return events.findIndex((event) => matchesCommand(event, matcher));
}

function lastCommandIndex(events: readonly TranscriptEvent[], matcher: CommandMatcher): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && matchesCommand(event, matcher)) return index;
  }
  return -1;
}

function firstChangeIndex(events: readonly TranscriptEvent[]): number {
  return events.findIndex((event) => event.type === "file_change");
}

function lastChangeIndex(events: readonly TranscriptEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "file_change") return index;
  }
  return -1;
}
