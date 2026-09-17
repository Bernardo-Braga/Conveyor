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

// Phase 2: the Line
import type { AddToLineResult, ProductDetail, ProductView, QuotaView } from '@conveyor/shared';
export const line = {
  add: (text: string) => request<AddToLineResult>('/line', { method: 'POST', body: JSON.stringify({ text }) }),
  fromShopify: (shopifyProductId: string) => request<AddToLineResult>('/line/from-shopify', { method: 'POST', body: JSON.stringify({ shopifyProductId }) }),
  products: () => request<ProductView[]>('/products'),
  product: (id: number) => request<ProductDetail>(`/products/${id}`),
  refreshSupplier: (id: number) => request<JobView>(`/products/${id}/refresh-supplier`, { method: 'POST' }),
  retry: (id: number) => request<JobView>(`/products/${id}/retry`, { method: 'POST' }),
  remove: (id: number) => request<{ ok: true }>(`/products/${id}`, { method: 'DELETE' }),
  quota: () => request<QuotaView[]>('/quota'),
};
export const listing = {
  write: (id: number) => request<JobView>(`/products/${id}/write-listing`, { method: 'POST' }),
};

// Phase 4: the Studio
import type { BatchView, CreativeView, GenerateBatchInput, PromptTemplateInput, PromptTemplateView } from '@conveyor/shared';
export const studio = {
  generate: (productId: number, body: Partial<GenerateBatchInput> = {}) => request<JobView>(`/products/${productId}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  batches: (productId: number) => request<BatchView[]>(`/products/${productId}/batches`),
  act: (creativeId: number, action: 'approve' | 'reject' | 'unapprove') => request<CreativeView>(`/creatives/${creativeId}/${action}`, { method: 'POST' }),
  regenerate: (creativeId: number, instruction: string | null = null) => request<JobView>(`/creatives/${creativeId}/regenerate`, { method: 'POST', body: JSON.stringify({ instruction }) }),
  templates: () => request<PromptTemplateView[]>('/prompt-templates'),
  createTemplate: (body: PromptTemplateInput) => request<PromptTemplateView>('/prompt-templates', { method: 'POST', body: JSON.stringify(body) }),
  saveTemplate: (id: number, body: PromptTemplateInput) => request<PromptTemplateView>(`/prompt-templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  setDefaultTemplate: (id: number) => request<PromptTemplateView>(`/prompt-templates/${id}/default`, { method: 'POST' }),
};

// Phase 6: Launch
import type { CampaignView, InterestRef, LaunchPreview, TemplateView } from '@conveyor/shared';
export interface TemplateList {
  templates: TemplateView[];
  folder: { dir: string; files: number };
  sync: { added: string[]; updated: string[]; missing: string[]; skipped: { file: string; reason: string }[] };
}
export const launch = {
  templates: () => request<TemplateList>('/templates'),
  template: (id: number) => request<{ view: TemplateView; json: Record<string, unknown> }>(`/templates/${id}`),
  saveTemplate: (id: number, json: Record<string, unknown>) => request<{ view: TemplateView; json: Record<string, unknown> }>(`/templates/${id}`, { method: 'PUT', body: JSON.stringify({ json }) }),
  duplicateTemplate: (id: number, name?: string) => request<TemplateView>(`/templates/${id}/duplicate`, { method: 'POST', body: JSON.stringify(name ? { name } : {}) }),
  deleteTemplate: (id: number) => request<{ ok: true; movedTo: string | null }>(`/templates/${id}`, { method: 'DELETE' }),
  importTemplate: (raw: unknown) => request<TemplateView>('/templates', { method: 'POST', body: JSON.stringify(raw) }),
  setDefaultTemplate: (id: number) => request<TemplateView[]>(`/templates/${id}/default`, { method: 'POST' }),
  exportUrl: (id: number, backup = false) => `/api/templates/${id}/export${backup ? '?backup=1' : ''}`,
  preview: (productId: number, templateId: number, acknowledge: string[]) => request<LaunchPreview>(`/products/${productId}/launch-preview?templateId=${templateId}&acknowledge=${acknowledge.join(',')}`),
  start: (productId: number, templateId: number, acknowledge: string[]) => request<JobView>(`/products/${productId}/launch`, { method: 'POST', body: JSON.stringify({ templateId, acknowledge }) }),
  campaigns: (productId: number) => request<CampaignView[]>(`/products/${productId}/campaigns`),
  resume: (campaignId: number) => request<JobView>(`/campaigns/${campaignId}/resume`, { method: 'POST' }),
  activate: (campaignId: number) => request<JobView>(`/campaigns/${campaignId}/activate`, { method: 'POST' }),
  pause: (campaignId: number) => request<JobView>(`/campaigns/${campaignId}/pause`, { method: 'POST' }),
  previews: (campaignId: number, format: string) => request<{ creativeId: string; html: string | null; code: number }[]>(`/campaigns/${campaignId}/previews?format=${format}`, { method: 'POST' }),
  findInterests: (labels: string[], productId: number | null) => request<JobView>('/interests/find', { method: 'POST', body: JSON.stringify({ labels, productId }) }),
  pickInterest: (label: string, interest: InterestRef) => request<{ ok: true }>('/interests/pick', { method: 'POST', body: JSON.stringify({ label, interest }) }),
  refreshInsights: () => request<JobView>('/insights/refresh', { method: 'POST' }),
};
