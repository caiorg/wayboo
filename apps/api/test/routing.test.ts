import type { Coord } from '@wayboo/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { MAX_TRACES_IN_FLIGHT, valhalla } from '../src/providers/routing';
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Resposta do `/trace_attributes` para um shape: o `edge_walk` devolve o mesmo shape. */
const traceOf = (encoded: string, edges: unknown[]) => ({ shape: encoded, edges, units: 'kilometers' });

let routeResponse: unknown = ROUTE;
let traceHandler: (body: Record<string, unknown>) => Response = (b) => json(traceOf(String(b.encoded_polyline), []));
const bodies: Record<string, unknown>[] = [];
const traces: Record<string, unknown>[] = [];
beforeEach(() => {
  bodies.length = 0;
  traces.length = 0;
  routeResponse = ROUTE;
  traceHandler = (b) => json(traceOf(String(b.encoded_polyline), []));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === `${config.valhallaUrl}/route`) {
        bodies.push(body);
        return json(routeResponse);
      }
      if (url === `${config.valhallaUrl}/trace_attributes`) {
        traces.push(body);
        return traceHandler(body);
      }
      throw new Error(`fetch inesperado: ${url}`);
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

describe('roteador Valhalla: limite de velocidade', () => {
  it('pede os limites da perna ao trace_attributes com edge_walk', async () => {
    await route();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      encoded_polyline: ROUTE.trip.legs[0]!.shape,
      shape_match: 'edge_walk',
      costing: 'auto',
      units: 'kilometers',
      filters: { action: 'include', attributes: expect.arrayContaining(['edge.speed_limit', 'edge.begin_shape_index', 'edge.end_shape_index', 'shape']) },
    });
  });

  it('leva os limites conhecidos para a rota', async () => {
    traceHandler = (b) =>
      json(
        traceOf(String(b.encoded_polyline), [
          { speed_limit: 60, begin_shape_index: 0, end_shape_index: 5 },
          { begin_shape_index: 5, end_shape_index: 10 },
        ]),
      );
    const [r] = await route();
    expect(r!.speedLimits).toEqual([{ beginIdx: 0, endIdx: 5, kmh: 60 }]);
  });

  it('desloca os índices de cada perna para a geometria da rota', async () => {
    const leg2: Coord[] = Array.from({ length: 6 }, (_, i): Coord => [-46.64, -23.56 + i * 0.001]);
    routeResponse = {
      trip: {
        legs: [
          ROUTE.trip.legs[0],
          {
            shape: encodePolyline(leg2),
            maneuvers: [
              { type: 1, length: 0.5, time: 40, begin_shape_index: 0, end_shape_index: 5 },
              { type: 4, length: 0, time: 0, begin_shape_index: 5, end_shape_index: 5 },
            ],
          },
        ],
        summary: { length: 1.5, time: 120 },
      },
    };
    traceHandler = (b) => {
      const first = b.encoded_polyline === ROUTE.trip.legs[0]!.shape;
      return json(traceOf(String(b.encoded_polyline), [{ speed_limit: first ? 50 : 40, begin_shape_index: 0, end_shape_index: first ? 10 : 5 }]));
    };
    const [r] = await valhalla.route(
      [{ lat: -23.56, lon: -46.65 }, { lat: -23.56, lon: -46.64 }, { lat: -23.555, lon: -46.64 }],
      OPTIONS,
      0,
    );
    // A segunda perna começa no ponto 10, que repete o fim da primeira.
    expect(r!.geometry).toHaveLength(16);
    expect(r!.speedLimits).toEqual([
      { beginIdx: 0, endIdx: 10, kmh: 50 },
      { beginIdx: 10, endIdx: 15, kmh: 40 },
    ]);
  });

  it('divide a perna longa em pedaços e junta os limites', async () => {
    // Três pontos a ~100 km um do outro: com pedaços de até 150 km, são dois pedaços que dividem o ponto 1.
    const long: Coord[] = [
      [-46.65, -23.56],
      [-46.65, -22.66],
      [-46.65, -21.76],
    ];
    routeResponse = {
      trip: {
        legs: [
          {
            shape: encodePolyline(long),
            maneuvers: [
              { type: 1, length: 200, time: 7200, begin_shape_index: 0, end_shape_index: 2 },
              { type: 4, length: 0, time: 0, begin_shape_index: 2, end_shape_index: 2 },
            ],
          },
        ],
        summary: { length: 200, time: 7200 },
      },
    };
    traceHandler = (b) => json(traceOf(String(b.encoded_polyline), [{ speed_limit: 110, begin_shape_index: 0, end_shape_index: 1 }]));
    const [r] = await route();
    expect(traces.map((t) => t.encoded_polyline)).toEqual([encodePolyline(long.slice(0, 2)), encodePolyline(long.slice(1, 3))]);
    expect(r!.speedLimits).toEqual([{ beginIdx: 0, endIdx: 2, kmh: 110 }]);
  });

  it('falha no trace_attributes não derruba a rota', async () => {
    traceHandler = () => new Response('falhou', { status: 500 });
    const [r] = await route();
    expect(r!.maneuvers).toHaveLength(3);
    expect(r!.speedLimits).toBeUndefined();
  });

  it('descarta os limites se o shape devolvido tiver os mesmos pontos em outra ordem', async () => {
    traceHandler = () =>
      json(traceOf(encodePolyline([...shape].reverse()), [{ speed_limit: 60, begin_shape_index: 0, end_shape_index: 10 }]));
    const [r] = await route();
    expect(r!.speedLimits).toBeUndefined();
  });

  it('com muitas consultas em voo, pula as excedentes em vez de enfileirar', async () => {
    // 12 pontos a ~100 km um do outro: 11 pedaços, mais que o teto de consultas simultâneas.
    const long: Coord[] = Array.from({ length: 12 }, (_, i): Coord => [-46.65, -23.56 + i * 0.9]);
    routeResponse = {
      trip: {
        legs: [
          {
            shape: encodePolyline(long),
            maneuvers: [
              { type: 1, length: 1100, time: 40000, begin_shape_index: 0, end_shape_index: 11 },
              { type: 4, length: 0, time: 0, begin_shape_index: 11, end_shape_index: 11 },
            ],
          },
        ],
        summary: { length: 1100, time: 40000 },
      },
    };
    traceHandler = (b) => json(traceOf(String(b.encoded_polyline), [{ speed_limit: 110, begin_shape_index: 0, end_shape_index: 1 }]));
    const [r] = await route();
    expect(traces).toHaveLength(MAX_TRACES_IN_FLIGHT);
    // Os pedaços consultados vêm primeiro; os pulados ficam sem limite.
    expect(r!.speedLimits).toEqual([{ beginIdx: 0, endIdx: MAX_TRACES_IN_FLIGHT, kmh: 110 }]);
  });

  it('descarta os limites se o shape devolvido não bater com o da rota', async () => {
    traceHandler = () =>
      json(traceOf(encodePolyline(shape.slice(0, 5)), [{ speed_limit: 60, begin_shape_index: 0, end_shape_index: 4 }]));
    const [r] = await route();
    expect(r!.speedLimits).toBeUndefined();
  });
});
