import type { PlanResponse, RoadAlert } from '@wayboo/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { db } from '../src/db';
import { client, makeRoute } from './helpers';

const ROUTE = makeRoute();

vi.mock('../src/providers/routing', () => ({
  valhalla: { name: 'test', route: async () => [structuredClone(ROUTE)] },
}));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
}));

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const { register, call, plan } = client(() => app, ROUTE);

/** Cada teste usa um ponto próprio, longe dos outros, para a deduplicação de ~80 m não juntar alertas. */
let spot = 0;
const nextSpot = () => ({ lat: -10 - ++spot * 0.01, lon: -40 });
const box = (p: { lat: number; lon: number }) =>
  `/alerts?minLat=${p.lat - 0.001}&minLon=${p.lon - 0.001}&maxLat=${p.lat + 0.001}&maxLon=${p.lon + 0.001}`;

async function reported(type: RoadAlert['type'] = 'accident') {
  const reporter = await register();
  const p = nextSpot();
  const { body } = await call<RoadAlert>(reporter, 'POST', '/alerts', { type, ...p });
  return { reporter, alert: body, p };
}

describe('GET /alerts', () => {
  it('diz quem é o autor e o voto de quem pergunta', async () => {
    const { reporter, alert, p } = await reported();
    const voter = await register();
    const other = await register();
    await call(voter, 'POST', `/alerts/${alert.id}/vote`, { up: false });

    const mine = (await call<{ alerts: RoadAlert[] }>(reporter, 'GET', box(p))).body.alerts[0]!;
    expect(mine).toMatchObject({ id: alert.id, mine: true, myVote: null });
    const voted = (await call<{ alerts: RoadAlert[] }>(voter, 'GET', box(p))).body.alerts[0]!;
    expect(voted).toMatchObject({ mine: false, myVote: 'down', downvotes: 1 });
    const fresh = (await call<{ alerts: RoadAlert[] }>(other, 'GET', box(p))).body.alerts[0]!;
    expect(fresh).toMatchObject({ mine: false, myVote: null });
  });

  it('sem token, responde sem os campos pessoais', async () => {
    const { p } = await reported();
    const res = await app.inject({ method: 'GET', url: box(p) });
    expect(res.statusCode).toBe(200);
    const a = res.json<{ alerts: RoadAlert[] }>().alerts[0]!;
    expect(a).not.toHaveProperty('mine');
    expect(a).not.toHaveProperty('myVote');
  });

  it('com token, a resposta não fica em cache compartilhado', async () => {
    const { reporter, p } = await reported();
    const res = await call(reporter, 'GET', box(p));
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('token inválido recebe 401', async () => {
    const { p } = await reported();
    const res = await app.inject({ method: 'GET', url: box(p), headers: { authorization: `Bearer ${'x'.repeat(43)}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /alerts/:id/vote', () => {
  it('confirmar devolve a contagem nova, o voto e renova a validade', async () => {
    const { alert } = await reported();
    // Deixa o alerta perto de expirar, para ver a confirmação renovar.
    db.prepare('UPDATE alerts SET expires_at = ? WHERE id = ?').run(Date.now() + 60_000, alert.id);
    const voter = await register();
    const res = await call<RoadAlert>(voter, 'POST', `/alerts/${alert.id}/vote`, { up: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: alert.id, upvotes: 1, downvotes: 0, mine: false, myVote: 'up' });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now() + 40 * 60_000);
  });

  it('negar devolve a contagem nova e encurta a validade', async () => {
    const { alert } = await reported();
    const voter = await register();
    const res = await call<RoadAlert>(voter, 'POST', `/alerts/${alert.id}/vote`, { up: false });
    expect(res.body).toMatchObject({ upvotes: 0, downvotes: 1, myVote: 'down' });
    expect(Date.parse(res.body.expiresAt)).toBeLessThan(Date.parse(alert.expiresAt));
  });

  it('três negações de saldo tiram o alerta do mapa', async () => {
    const { alert, p } = await reported();
    let last: RoadAlert | null = null;
    for (let i = 0; i < 3; i++) last = (await call<RoadAlert>(await register(), 'POST', `/alerts/${alert.id}/vote`, { up: false })).body;
    expect(last!.downvotes).toBe(3);
    expect(Date.parse(last!.expiresAt)).toBeLessThanOrEqual(Date.now());
    const after = await call<{ alerts: RoadAlert[] }>(await register(), 'GET', box(p));
    expect(after.body.alerts).toEqual([]);
  });

  it('voto repetido recebe 409 e não muda a contagem', async () => {
    const { alert } = await reported();
    const voter = await register();
    await call(voter, 'POST', `/alerts/${alert.id}/vote`, { up: true });
    const again = await call<{ error: string }>(voter, 'POST', `/alerts/${alert.id}/vote`, { up: false });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Você já votou neste alerta');
    const row = db.prepare('SELECT up, down FROM alerts WHERE id = ?').get(alert.id) as { up: number; down: number };
    expect(row).toEqual({ up: 1, down: 0 });
  });

  it('o autor recebe 403 ao votar no próprio alerta', async () => {
    const { reporter, alert } = await reported();
    const res = await call<{ error: string }>(reporter, 'POST', `/alerts/${alert.id}/vote`, { up: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Você não pode votar no próprio alerta');
  });

  it('alerta expirado recebe 404 e não volta ao mapa', async () => {
    const { alert, p } = await reported();
    db.prepare('UPDATE alerts SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, alert.id);
    const voter = await register();
    const res = await call<{ error: string }>(voter, 'POST', `/alerts/${alert.id}/vote`, { up: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Alerta não encontrado');
    expect((await call<{ alerts: RoadAlert[] }>(voter, 'GET', box(p))).body.alerts).toEqual([]);
  });

  it('alerta inexistente recebe 404', async () => {
    const res = await call(await register(), 'POST', '/alerts/00000000-0000-4000-8000-000000000000/vote', { up: true });
    expect(res.status).toBe(404);
  });
});

describe('POST /alerts', () => {
  it('o novo alerta volta marcado como do autor', async () => {
    const { alert } = await reported();
    expect(alert).toMatchObject({ mine: true, myVote: null, upvotes: 0 });
  });

  it('reportar o mesmo tipo perto confirma o alerta existente', async () => {
    const { alert, p } = await reported('police');
    const res = await call<RoadAlert>(await register(), 'POST', '/alerts', { type: 'police', lat: p.lat + 0.0001, lon: p.lon });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: alert.id, upvotes: 1, myVote: 'up' });
  });

  it('reportar de novo o próprio alerta, ou um já confirmado, não dá erro', async () => {
    const { reporter, alert, p } = await reported('police');
    const again = await call<RoadAlert>(reporter, 'POST', '/alerts', { type: 'police', ...p });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: alert.id, upvotes: 0, mine: true });
    const voter = await register();
    await call(voter, 'POST', '/alerts', { type: 'police', ...p });
    const twice = await call<RoadAlert>(voter, 'POST', '/alerts', { type: 'police', ...p });
    expect(twice.status).toBe(200);
    expect(twice.body).toMatchObject({ upvotes: 1, myVote: 'up' });
  });
});

describe('POST /plan', () => {
  it('os alertas da rota trazem o voto de quem planejou', async () => {
    const reporter = await register();
    const [lon, lat] = ROUTE.geometry[20]!;
    const { body: alert } = await call<RoadAlert>(reporter, 'POST', '/alerts', { type: 'hazard', lat, lon });
    const voter = await register();
    await call(voter, 'POST', `/alerts/${alert.id}/vote`, { up: true });
    const p: PlanResponse = await plan(voter);
    const onRoute = p.routes.flatMap((r) => r.alerts).find((a) => a.id === alert.id);
    expect(onRoute).toMatchObject({ mine: false, myVote: 'up' });
  });
});
