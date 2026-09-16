import { describe, expect, it } from 'vitest';
import { dropTokenKeys, redact, safeUrl } from '../src/http/redact.ts';

describe('redact', () => {
  it('removes known secret values exactly', () => {
    expect(redact('key is hunter2secret here', ['hunter2secret'])).toBe('key is [redacted] here');
  });
  it('removes common key shapes', () => {
    expect(redact('sk-ant-api03-abcdefghijklmnop')).toBe('[redacted]');
    expect(redact('Authorization: Bearer EAAGm0PX4ZCpsBAJZCZBZBZBZBZBZBZBZB')).toContain('[redacted]');
    expect(redact('token shpat_0123456789abcdef0123456789abcdef')).toBe('token [redacted]');
    expect(redact('?access_token=EAAB123456789012345678&x=1')).toBe('?access_token=[redacted]&x=1');
  });
  it('keeps ordinary text', () => {
    expect(redact('Meta error code 190 / subcode 463 (request AbCdEf123)')).toBe('Meta error code 190 / subcode 463 (request AbCdEf123)');
  });
});

describe('safeUrl', () => {
  it('drops the query string and fragment', () => {
    expect(safeUrl('https://graph.facebook.com/v26.0/me?access_token=EAAB123&fields=id#x')).toBe('https://graph.facebook.com/v26.0/me');
  });
});

describe('dropTokenKeys', () => {
  it('removes token-like keys at any depth', () => {
    const out = dropTokenKeys({ name: 'x', access_token: 'EAAB', nested: [{ api_key: 'k', keep: 1 }], clientSecret: 's' });
    expect(out).toEqual({ name: 'x', nested: [{ keep: 1 }] });
  });
});
