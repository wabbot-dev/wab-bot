export interface Verdict { state: "pending" | "failure" | "success"; description: string }
export function readinessLines(markdown: string): string[];
export function evaluateReadiness(pull: { draft?: boolean; body?: string | null }, template: string): Verdict;
export function runReadinessCheck(args: { github: any; context: any; core: any }): Promise<Verdict | undefined>;
