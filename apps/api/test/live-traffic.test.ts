import { simulateDrive, type PlanResponse } from '@wayboo/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { db, purgeExpiredTraces } from '../src/db';
import { client, makeRoute, TZ, type User } from './helpers';

const ROUTE = makeRoute();
const MIN = 60_000;

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
beforeEach(() => {
  db.exec('DELETE FROM live_obs');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 24, 15, 0));
});
afterEach(() => vi.useRealTimers());

const { register, call, plan } = client(() => app, ROUTE);

/** Usuário que está dirigindo agora a `factor` vezes o tempo do roteador. Envia o rastro sem encerrar a viagem. */
async function driving(shareCrowd: boolean, factor = 2): Promise<User> {
  const user = await register();
  if (shareCrowd) await call(user, 'PUT', '/privacy', { shareCrowd: true });
  const p = await plan(user);
  const { body: trip } = await call<{ tripId: string }>(user, 'POST', '/trips', { planId: p.planId, routeIndex: 0, timeZone: TZ });
  const r = p.routes[0]!.route;
  const durations = r.segments.map((s) => s.baseDurationS * factor);
  // O rastro inteiro chega num envio logo após a partida: o relógio do aparelho fica ~12 min à frente do servidor,
  // e a API mede a idade de cada trecho pela distância até a última amostra.
  const samples = [...simulateDrive(r, durations, Date.now() + 1000, 2)];
  expect((await call(user, 'POST', `/trips/${trip.tripId}/samples`, { samples })).status).toBe(200);
  return user;
}

const etaOf = (p: PlanResponse) => p.routes[0]!.eta;
const liveRows = (userId?: string) =>
  (userId
    ? db.prepare('SELECT * FROM live_obs WHERE user_id = ?').all(userId)
    : db.prepare('SELECT * FROM live_obs').all()) as { seg: string; user_id: string; t: number; x: number }[];

describe('trânsito ao vivo', () => {
  it('com 3 usuários com opt-in, o ETA de outro usuário reflete a lentidão no próximo pedido', async () => {
    const observer = await register();
    const before = etaOf(await plan(observer));
    expect(before.durationS).toBeCloseTo(ROUTE.baseDurationS, 3);

    for (let i = 0; i < 3; i++) await driving(true);
    vi.setSystemTime(Date.now() + 15_000);
    const after = etaOf(await plan(observer));
    expect(after.durationS).toBeGreaterThan(before.durationS * 1.25);
    expect(after.factors.find((f) => f.kind === 'live')?.deltaS).toBeGreaterThan(0);
  });

  it('quem consulta não conta para o mínimo', async () => {
    const drivers = [await driving(true), await driving(true), await driving(true)];
    expect(etaOf(await plan(drivers[0]!)).durationS).toBeCloseTo(ROUTE.baseDurationS, 3);
  });

  it('com só 2 usuários no trecho, o valor não é publicado', async () => {
    await driving(true);
    await driving(true);
    expect(liveRows().length).toBeGreaterThan(0);
    const observer = await register();
    expect(etaOf(await plan(observer)).durationS).toBeCloseTo(ROUTE.baseDurationS, 3);
  });

  it('sem opt-in, as amostras não entram no ao vivo', async () => {
    for (let i = 0; i < 3; i++) await driving(false);
    expect(liveRows()).toEqual([]);
    const observer = await register();
    expect(etaOf(await plan(observer)).durationS).toBeCloseTo(ROUTE.baseDurationS, 3);
  });

  it('guarda uma observação por usuário e trecho, sem o rastro', async () => {
    const user = await driving(true);
    const rows = liveRows(user.userId);
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.seg)).size).toBe(rows.length);
    expect(Object.keys(rows[0]!).sort()).toEqual(['seg', 't', 'user_id', 'x']);
    for (const r of rows) {
      expect(r.t).toBeLessThanOrEqual(Date.now());
      expect(r.t).toBeGreaterThanOrEqual(Date.now() - 15 * MIN);
      expect(r.x).toBeCloseTo(Math.log(2), 1);
    }
  });

  it('observações com mais de 15 min deixam de valer e saem do banco', async () => {
    for (let i = 0; i < 3; i++) await driving(true);
    vi.setSystemTime(Date.now() + 16 * MIN);
    const observer = await register();
    expect(etaOf(await plan(observer)).durationS).toBeCloseTo(ROUTE.baseDurationS, 3);
    expect(liveRows()).toEqual([]);
  });

  it('a rotina de retenção apaga as observações vencidas', async () => {
    await driving(true);
    expect(liveRows().length).toBeGreaterThan(0);
    const r = purgeExpiredTraces(24 * 3_600_000, Date.now() + 16 * MIN);
    expect(r.liveObservations).toBeGreaterThan(0);
    expect(liveRows()).toEqual([]);
  });

  it('revogar o opt-in apaga as observações ao vivo do usuário', async () => {
    const user = await driving(true);
    const other = await driving(true);
    await call(user, 'PUT', '/privacy', { shareCrowd: false });
    expect(liveRows(user.userId)).toEqual([]);
    expect(liveRows(other.userId).length).toBeGreaterThan(0);
  });

  it('entra na exportação e sai com DELETE /me', async () => {
    const user = await driving(true);
    const exported = await call<{ tables: Record<string, unknown[]> }>(user, 'GET', '/me/export');
    expect(exported.body.tables.live_obs?.length).toBe(liveRows(user.userId).length);
    expect((await call(user, 'DELETE', '/me')).status).toBe(200);
    expect(liveRows(user.userId)).toEqual([]);
  });
});
