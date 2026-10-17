/**
 * Logs carry IDs and counters only: never message bodies, names, phone numbers or tokens.
 * Callers must pass only primitive IDs/counters; strings are length-capped as a backstop.
 */
import { redactShapes } from "./redact";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type Logger = (event: string, fields?: LogFields) => void;

export const consoleLog: Logger = (event, fields = {}) => {
  const safe: Record<string, unknown> = { event };
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = typeof v === "string" ? redactShapes(v).slice(0, 80) : v; // key-shaped values never reach a log line
  }
  console.log(JSON.stringify(safe));
};

export const noopLog: Logger = () => {};
