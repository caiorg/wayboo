import type { Coord } from '@wayboo/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { valhalla } from '../src/providers/routing';
import { encodePolyline } from './helpers';

const shape: Coord[] = Array.from({ length: 11 }, (_, i): Coord => [-46.65 + i * 0.001, -23.56]);
const OPTIONS = { avoidTolls: false, avoidHighways: false, avoidFerries: false };

/** Resposta nativa do Valhalla com `turn_lanes` ligado. */
const ROUTE = {
  trip: {
    legs: [
      {
        shape: encodePolyline(shape),
        maneuvers: [
          { type: 1, street_names: ['Rua A'], length: 0.5, time: 40, begin_shape_index: 0, end_shape_index: 5 },
          {
            type: 15,
            street_names: ['Rua B'],
            length: 0.5,
            time: 40,
            begin_shape_index: 5,
            end_shape_index: 10,
            lanes: [{ directions: 8, active: 8 }, { directions: 10, valid: 8 }, { directions: 2 }],
          },
          { type: 4, length: 0, time: 0, begin_shape_index: 10, end_shape_index: 10 },
        ],
      },
    ],
    summary: { length: 1, time: 80 },
  },
};

const bodies: Record<string, unknown>[] = [];
beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${config.valhallaUrl}/route`)) throw new Error(`fetch inesperado: ${url}`);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(ROUTE), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const route = () => valhalla.route([{ lat: -23.56, lon: -46.65 }, { lat: -23.56, lon: -46.64 }], OPTIONS, 0);

describe('roteador Valhalla: faixas', () => {
  it('pede as faixas por manobra', async () => {
    await route();
    expect(bodies[0]).toMatchObject({ turn_lanes: true });
  });

  it('leva as faixas da manobra para a rota', async () => {
    const [r] = await route();
    expect(r!.maneuvers[1]!.lanes).toEqual([{ directions: 8, active: 8 }, { directions: 10, valid: 8 }, { directions: 2 }]);
  });

  it('manobra sem faixas na resposta fica sem faixas', async () => {
    const [r] = await route();
    expect(r!.maneuvers[0]!.lanes).toBeUndefined();
    expect('lanes' in r!.maneuvers[0]!).toBe(false);
  });
});
