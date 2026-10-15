import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy } from './csp.ts';

function directive(policy: string | null, name: string): string | undefined {
  return policy
    ?.split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);
}

describe('the page’s policy', () => {
  it('lets the page reach its own Supabase project and nothing else', () => {
    const policy = contentSecurityPolicy('https://abcdefgh.supabase.co');
    expect(directive(policy, 'connect-src')).toBe("'self' https://abcdefgh.supabase.co");
  });

  it('names the origin, not the path, the credentials or the case it was written in', () => {
    const policy = contentSecurityPolicy('HTTPS://user:pw@Abc.Supabase.co/rest/v1/?x=1#y');
    expect(directive(policy, 'connect-src')).toBe("'self' https://abc.supabase.co");
  });

  it('keeps the port of a local stack', () => {
    const policy = contentSecurityPolicy('http://127.0.0.1:54321/');
    expect(directive(policy, 'connect-src')).toBe("'self' http://127.0.0.1:54321");
  });

  it('runs only the page’s own scripts and styles', () => {
    const policy = contentSecurityPolicy('https://a.supabase.co');
    expect(directive(policy, 'script-src')).toBe("'self'");
    expect(directive(policy, 'style-src')).toBe("'self'");
    expect(directive(policy, 'default-src')).toBe("'self'");
    expect(directive(policy, 'object-src')).toBe("'none'");
    expect(directive(policy, 'base-uri')).toBe("'none'");
    expect(policy).not.toContain('unsafe');
  });

  it('lets a bundle built without a Supabase URL reach only itself', () => {
    expect(directive(contentSecurityPolicy(undefined), 'connect-src')).toBe("'self'");
  });

  it('is refused for anything but an http(s) URL', () => {
    expect(contentSecurityPolicy('')).toBeNull();
    expect(contentSecurityPolicy('abcdefgh.supabase.co')).toBeNull();
    expect(contentSecurityPolicy('javascript:alert(1)')).toBeNull();
    expect(contentSecurityPolicy('wss://a.supabase.co')).toBeNull();
  });
});
