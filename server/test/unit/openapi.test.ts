import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

describe('OpenAPI document', () => {
  const spec = YAML.parse(fs.readFileSync(path.join(root, 'openapi.yaml'), 'utf8'));

  it('documents exactly the routes implemented in code', () => {
    const specOps = new Set<string>();
    for (const [p, ops] of Object.entries<any>(spec.paths))
      for (const m of Object.keys(ops)) if (m !== 'parameters') specOps.add(`${m.toUpperCase()} ${p.replace(/\{[^}]+\}/g, ':x')}`);
    const mounts: Record<string, string> = { auth: '/auth', me: '/me', catalog: '', bookings: '/bookings', orders: '/orders', subscriptions: '/subscriptions', payments: '/payments', admin: '/admin', rider: '/rider' };
    const code = new Set<string>();
    for (const [f, base] of Object.entries(mounts)) {
      const src = fs.readFileSync(path.join(root, `src/routes/${f}.ts`), 'utf8');
      for (const m of src.matchAll(/(\w+)Router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
        const b = m[1] === 'plans' ? '/subscription-plans' : base;
        code.add(`${m[2].toUpperCase()} ${(b + (m[3] === '/' ? '' : m[3])).replace(/:\w+/g, ':x')}`);
      }
    }
    expect([...code].filter((c) => !specOps.has(c))).toEqual([]);
    expect([...specOps].filter((s) => !code.has(s))).toEqual([]);
  });

  it('is served by the app', async () => {
    const { createApp } = await import('../../src/app.js');
    const r = await request(createApp()).get('/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
  });
});
