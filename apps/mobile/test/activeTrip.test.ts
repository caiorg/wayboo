import type { PlanResponse } from '@wayboo/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_TRIP_MAX_AGE_MS, clearActiveTrip, loadActiveTrip, saveActiveTrip, type ActiveTrip } from '../src/lib/activeTrip';

const h = vi.hoisted(() => ({ async: new Map<string, string>(), setFails: false }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.async.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (h.setFails) throw new Error('disco cheio');
      h.async.set(k, v);
    },
    removeItem: async (k: string) => void h.async.delete(k),
  },
}));

const KEY = 'wayboo-active-trip';
const NOW = 1_800_000_000_000;

const plan = {
  planId: 'p1',
  waypoints: [],
  routes: [{ route: { id: 'r0' } }, { route: { id: 'r1' } }],
} as unknown as PlanResponse;

const trip = (patch: Partial<ActiveTrip> = {}): ActiveTrip => ({
  savedAt: NOW,
  apiUrl: 'https://api.wayboo.app',
  plan,
  routeIndex: 1,
  stops: [{ lat: -23.5, lon: -46.6, visited: true }],
  tripId: 't1',
  buffer: [{ t: 1, lat: -23.5, lon: -46.6, speed: null, heading: null, accuracy: 5 }],
  ...patch,
});

beforeEach(() => {
  h.async.clear();
  h.setFails = false;
});

describe('viagem ativa gravada no aparelho', () => {
  it('devolve o que foi gravado', async () => {
    await saveActiveTrip(trip());
    expect(await loadActiveTrip('https://api.wayboo.app', NOW + 1000)).toEqual(trip());
  });

  it('sem nada gravado devolve null', async () => {
    expect(await loadActiveTrip('https://api.wayboo.app', NOW)).toBeNull();
  });

  it('descarta e apaga a viagem velha demais para retomar', async () => {
    await saveActiveTrip(trip());
    expect(await loadActiveTrip('https://api.wayboo.app', NOW + ACTIVE_TRIP_MAX_AGE_MS + 1)).toBeNull();
    expect(h.async.has(KEY)).toBe(false);
  });

  it('em outro servidor mantém a rota, mas não a viagem nem o rastro', async () => {
    await saveActiveTrip(trip());
    const loaded = await loadActiveTrip('https://outro.exemplo', NOW);
    expect(loaded).toMatchObject({ plan, routeIndex: 1, tripId: null, buffer: [] });
  });

  it('descarta e apaga JSON corrompido ou de outro formato', async () => {
    h.async.set(KEY, '{não é json');
    expect(await loadActiveTrip('https://api.wayboo.app', NOW)).toBeNull();
    expect(h.async.has(KEY)).toBe(false);

    h.async.set(KEY, JSON.stringify({ v: 99, ...trip() }));
    expect(await loadActiveTrip('https://api.wayboo.app', NOW)).toBeNull();
    expect(h.async.has(KEY)).toBe(false);
  });

  it('descarta rota que não existe no plano', async () => {
    await saveActiveTrip(trip({ routeIndex: 5 }));
    expect(await loadActiveTrip('https://api.wayboo.app', NOW)).toBeNull();
  });

  it('apagar depois de gravar vence, mesmo com a gravação ainda pendente', async () => {
    const saving = saveActiveTrip(trip());
    await clearActiveTrip();
    await saving;
    expect(await loadActiveTrip('https://api.wayboo.app', NOW)).toBeNull();
  });

  it('falha de disco não vira erro para quem grava', async () => {
    h.setFails = true;
    await expect(saveActiveTrip(trip())).resolves.toBeUndefined();
  });
});
