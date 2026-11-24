import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { CROWD, db } from '../src/db';
import { client, makeRoute, type User } from './helpers';

const ROUTE = makeRoute();
const DAY_MS = 86_400_000;

vi.mock('../src/providers/routing', () => ({ valhalla: { name: 'test', route: async () => [structuredClone(ROUTE)] } }));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
}));

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const api = client(() => app, ROUTE);
const { register, call } = api;
const drive = async (user: User) => (await api.drive(user)).finished!;

const rows = (userId: string) =>
  db.prepare('SELECT key, seg, w, mean, m2, t FROM stats WHERE user_id = ? ORDER BY key').all(userId) as {
    key: string;
    t: number;
  }[];

describe('opt-in do aprendizado coletivo', () => {
  it('vem desligado e a viagem sem opt-in não altera nenhuma linha do agregado', async () => {
    const user = await register();
    expect((await call(user, 'GET', '/privacy')).body).toEqual({ shareCrowd: false });

    const before = rows(CROWD);
    const res = await drive(user);

    expect(res.learnedSegments).toBeGreaterThan(0);
    expect(rows(user.userId).length).toBeGreaterThan(0);
    expect(rows(CROWD)).toEqual(before);
  });

  it('com opt-in soma só chaves de trecho e contexto, com a data sem horário', async () => {
    const user = await register();
    expect((await call(user, 'PUT', '/privacy', { shareCrowd: true })).body).toEqual({ shareCrowd: true });

    await drive(user);

    const crowd = rows(CROWD);
    expect(crowd.length).toBeGreaterThan(0);
    for (const r of crowd) {
      expect(r.key).toMatch(/^(sb|s|c)\|/);
      expect(r.t % DAY_MS).toBe(0);
      expect(JSON.stringify(r)).not.toContain(user.userId);
    }
  });

  it('revogar o opt-in interrompe novas contribuições', async () => {
    const user = await register();
    await call(user, 'PUT', '/privacy', { shareCrowd: true });
    expect((await call(user, 'PUT', '/privacy', { shareCrowd: false })).body).toEqual({ shareCrowd: false });

    const before = rows(CROWD);
    await drive(user);
    expect(rows(CROWD)).toEqual(before);
  });

  it('sem opt-in o usuário ainda usa o que os outros compartilharam', async () => {
    const sharer = await register();
    await call(sharer, 'PUT', '/privacy', { shareCrowd: true });
    await drive(sharer);

    const user = await register();
    const plan = await api.plan(user);
    const eta = plan.routes[0]!.eta;
    expect(rows(user.userId)).toEqual([]);
    expect(eta.durationS).toBeGreaterThan(eta.baseDurationS * 1.1);
  });

  it('valida o corpo', async () => {
    expect((await call(await register(), 'PUT', '/privacy', { shareCrowd: 'sim' })).status).toBe(400);
  });
});

// CWE-525: o cliente não guarda cópia de resposta com dado do usuário.
describe('cache-control', () => {
  it('as rotas com dado pessoal respondem no-store, inclusive no erro', async () => {
    const reg = await app.inject({ method: 'POST', url: '/auth/device', payload: { token: 'x'.repeat(43) } });
    expect(reg.headers['cache-control']).toBe('no-store');

    const user = await register();
    const routes: [Parameters<typeof call>[1], string, object?][] = [
      ['GET', '/privacy'],
      ['PUT', '/privacy', { shareCrowd: false }],
      ['GET', '/insights'],
      ['GET', '/devices'],
      ['POST', '/plan', api.planRequest],
      ['GET', '/reverse'], // 400 na validação, sem chamar a rede
    ];
    for (const [method, url, payload] of routes) {
      const res = await call(user, method, url, payload);
      expect(res.headers['cache-control'], `${method} ${url}`).toBe('no-store');
      if (url === '/reverse') expect(res.status).toBe(400);
    }

    const anon = await app.inject({ method: 'GET', url: '/insights' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['cache-control']).toBe('no-store');

    expect((await app.inject({ method: 'GET', url: '/nao-existe' })).headers['cache-control']).toBe('no-store');
  });
});
