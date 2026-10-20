export const VERSION: string;
export const REQUIRED_SCOPES: string[];
export const DEFAULT_GRAPH_VERSION: string;
export const NEW_APP_STEPS: string[];
export class Redactor { add(s: string): void; redact(t: string): string; }
export function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; errors: string[] };
export function writeSecretsFile(path: string, entries: Record<string, string>, opts?: { force?: boolean; platform?: string }): { mode: string; enforced: boolean };
export interface MainDeps {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: any) => Promise<any>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  prompter?: { visible(label: string): Promise<string>; hidden(label: string): Promise<string> } | null;
  now?: () => Date;
  spawn?: (cmd: string, args: string[], opts: any) => { status: number | null };
  writeSecrets?: typeof writeSecretsFile;
  writeFile?: (path: string, content: string) => void;
}
export function main(argv: string[], deps?: MainDeps): Promise<{ code: number; bundle?: any }>;
