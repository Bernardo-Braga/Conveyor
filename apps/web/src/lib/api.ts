import type { ConnectionStatus, JobView, LedgerEntry, SecretStatus, SettingsSection } from '@conveyor/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: unknown };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.issues);
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; env: string; dataDir: string; versions: Record<string, unknown> }>('/health'),
  jobs: (limit = 50) => request<JobView[]>(`/jobs?limit=${limit}`),
  retryJob: (id: number) => request<JobView>(`/jobs/${id}/retry`, { method: 'POST' }),
  ledger: (limit = 100) => request<LedgerEntry[]>(`/ledger?limit=${limit}`),
  settings: <T>(section: SettingsSection) => request<T>(`/settings/${section}`),
  saveSettings: <T>(section: SettingsSection, value: unknown) => request<T>(`/settings/${section}`, { method: 'PUT', body: JSON.stringify(value) }),
  secrets: () => request<SecretStatus[]>('/secrets'),
  setSecret: (name: string, value: string) => request<{ ok: true }>(`/secrets/${name}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteSecret: (name: string) => request<{ ok: true }>(`/secrets/${name}`, { method: 'DELETE' }),
  connections: () => request<ConnectionStatus[]>('/connections'),
  testConnection: (service: string) => request<JobView>(`/connections/${service}/test`, { method: 'POST' }),
};
