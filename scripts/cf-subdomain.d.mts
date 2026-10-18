export interface CfResponse { success: boolean; status?: number; result?: any; errors?: { code?: number; message: string }[] }
export interface CfClient { request(req: { method: string; path: string; query?: Record<string, unknown>; body?: any; contentType?: string; rawBody?: boolean }): Promise<CfResponse> }
export interface EnsureSubdomainOptions { workerName?: string; subdomain?: string; attempts?: number; random?: () => string }
export type EnsureSubdomainResult = { ok: true; created: boolean; subdomain: string } | { ok: false; error: string };
export function ensureSubdomain(cloudflare: CfClient, accountId: string, opts?: EnsureSubdomainOptions): Promise<EnsureSubdomainResult>;
