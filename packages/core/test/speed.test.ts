import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type Coord } from '../src/geo';
import { createNavigator } from '../src/navigation';
import { buildSegments } from '../src/route';
import { SPEED_LIMIT_TOLERANCE_KMH, appendSpeedLimits, isOverSpeedLimit, parseValhallaSpeedLimits, speedLimitAt } from '../src/speed';
import type { Route, SpeedLimitSpan } from '../src/types';

describe('limite de velocidade: parse do Valhalla', () => {
  it('converte as arestas do trace_attributes em trechos com limite', () => {
    const edges = [
      { speed_limit: 60, begin_shape_index: 0, end_shape_index: 3 },
      { speed_limit: 60, begin_shape_index: 3, end_shape_index: 5 },
      { begin_shape_index: 5, end_shape_index: 7 },
      { speed_limit: 40, begin_shape_index: 7, end_shape_index: 10 },
    ];
    // Arestas seguidas com o mesmo limite viram um trecho; aresta sem limite fica de fora.
    expect(parseValhallaSpeedLimits(edges, 11)).toEqual([
      { beginIdx: 0, endIdx: 5, kmh: 60 },
      { beginIdx: 7, endIdx: 10, kmh: 40 },
    ]);
  });

  it('limite "unlimited" ou fora da faixa plausível não vira número', () => {
    const edges = [
      { speed_limit: 'unlimited', begin_shape_index: 0, end_shape_index: 2 },
      { speed_limit: 0, begin_shape_index: 2, end_shape_index: 4 },
      { speed_limit: 400, begin_shape_index: 4, end_shape_index: 6 },
      { speed_limit: 80, begin_shape_index: 6, end_shape_index: 8 },
    ];
    expect(parseValhallaSpeedLimits(edges, 9)).toEqual([{ beginIdx: 6, endIdx: 8, kmh: 80 }]);
  });

  it('índices fora do shape ou fora de ordem invalidam a resposta inteira', () => {
    expect(parseValhallaSpeedLimits([{ speed_limit: 60, begin_shape_index: 0, end_shape_index: 12 }], 11)).toBeUndefined();
    expect(parseValhallaSpeedLimits([{ speed_limit: 60, begin_shape_index: 4, end_shape_index: 2 }], 11)).toBeUndefined();
    expect(
      parseValhallaSpeedLimits(
        [
          { speed_limit: 60, begin_shape_index: 0, end_shape_index: 5 },
          { speed_limit: 40, begin_shape_index: 3, end_shape_index: 8 },
        ],
        11,
      ),
    ).toBeUndefined();
    expect(parseValhallaSpeedLimits('x', 11)).toBeUndefined();
    expect(parseValhallaSpeedLimits([null], 11)).toBeUndefined();
  });

  it('sem nenhum limite conhecido, devolve lista vazia', () => {
    expect(parseValhallaSpeedLimits([{ begin_shape_index: 0, end_shape_index: 10 }], 11)).toEqual([]);
  });
});

describe('limite de velocidade: junção de pedaços', () => {
  it('desloca os índices e junta trechos vizinhos com o mesmo limite', () => {
    const all: SpeedLimitSpan[] = [{ beginIdx: 0, endIdx: 10, kmh: 80 }];
    appendSpeedLimits(all, [{ beginIdx: 0, endIdx: 4, kmh: 80 }, { beginIdx: 4, endIdx: 6, kmh: 60 }], 10);
    expect(all).toEqual([
      { beginIdx: 0, endIdx: 14, kmh: 80 },
      { beginIdx: 14, endIdx: 16, kmh: 60 },
    ]);
  });

  it('não junta trechos separados por um buraco sem limite', () => {
    const all: SpeedLimitSpan[] = [{ beginIdx: 0, endIdx: 5, kmh: 80 }];
    appendSpeedLimits(all, [{ beginIdx: 2, endIdx: 4, kmh: 80 }], 5);
    expect(all).toEqual([
      { beginIdx: 0, endIdx: 5, kmh: 80 },
      { beginIdx: 7, endIdx: 9, kmh: 80 },
    ]);
  });
});

describe('limite de velocidade: regras de exibição', () => {
  const spans: SpeedLimitSpan[] = [
    { beginIdx: 0, endIdx: 5, kmh: 60 },
    { beginIdx: 7, endIdx: 10, kmh: 40 },
  ];

  it('acha o limite do trecho da polyline em que o carro está', () => {
    expect(speedLimitAt(spans, 0)).toBe(60);
    expect(speedLimitAt(spans, 4)).toBe(60);
    // O trecho i vai do ponto i ao i+1: o 5 já é da aresta sem limite.
    expect(speedLimitAt(spans, 5)).toBeNull();
    expect(speedLimitAt(spans, 6)).toBeNull();
    expect(speedLimitAt(spans, 9)).toBe(40);
    expect(speedLimitAt(undefined, 0)).toBeNull();
  });

  it('avisa só acima do limite mais a margem do GPS', () => {
    const ms = (kmh: number) => kmh / 3.6;
    expect(isOverSpeedLimit(ms(60 + SPEED_LIMIT_TOLERANCE_KMH), 60)).toBe(false);
    expect(isOverSpeedLimit(ms(60 + SPEED_LIMIT_TOLERANCE_KMH + 1), 60)).toBe(true);
    expect(isOverSpeedLimit(null, 60)).toBe(false);
    expect(isOverSpeedLimit(ms(200), null)).toBe(false);
  });
});

describe('limite de velocidade: navegação', () => {
  // Reta de 10 trechos de ~100 m.
  const geometry: Coord[] = Array.from({ length: 11 }, (_, i): Coord => [-46.65 + i * 0.001, -23.56]);
  const cum = cumulativeDistances(geometry);
  const maneuvers: Route['maneuvers'] = [
    { type: 1, instruction: 'Siga', streetNames: ['Rua A'], distanceM: cum[10]!, durationS: 80, beginIdx: 0, endIdx: 10, toll: false, highway: false },
    { type: 4, instruction: 'Chegou', streetNames: [], distanceM: 0, durationS: 0, beginIdx: 10, endIdx: 10, toll: false, highway: false },
  ];
  const route = (speedLimits?: SpeedLimitSpan[]): Route => ({
    id: 'r',
    geometry,
    distanceM: cum[10]!,
    baseDurationS: 80,
    maneuvers,
    hasToll: false,
    hasHighway: false,
    hasFerry: false,
    highwayShare: 0,
    segments: buildSegments(geometry, maneuvers),
    provider: 'test',
    ...(speedLimits ? { speedLimits } : {}),
  });
  const at = (i: number, kmh: number | null, t: number) => ({
    t,
    lat: -23.56,
    lon: -46.65 + i * 0.001,
    speed: kmh === null ? null : kmh / 3.6,
    accuracy: 5,
  });

  it('informa o limite atual e a velocidade, sem inventar quando falta', () => {
    const nav = createNavigator(route([{ beginIdx: 0, endIdx: 5, kmh: 60 }]));
    const s1 = nav.update(at(2.5, 50, 1000));
    expect(s1.speedLimitKmh).toBe(60);
    expect(s1.speedKmh).toBe(50);
    const s2 = nav.update(at(7.5, null, 2000));
    expect(s2.speedLimitKmh).toBeNull();
    expect(s2.speedKmh).toBeNull();
    expect(createNavigator(route()).update(at(2.5, 50, 1000)).speedLimitKmh).toBeNull();
  });

  it('avisa por voz uma vez por trecho depois de duas leituras acima do limite', () => {
    const nav = createNavigator(route([{ beginIdx: 0, endIdx: 10, kmh: 40 }]));
    nav.update(at(0.2, 30, 1000)); // anúncio de saída
    const a = nav.update(at(0.4, 60, 8000));
    expect(a.overSpeedLimit).toBe(false);
    const b = nav.update(at(0.6, 60, 9000));
    expect(b.overSpeedLimit).toBe(true);
    expect(b.announcement).toBe('Atenção: limite de 40 km/h');
    const c = nav.update(at(0.8, 60, 10000));
    expect(c.overSpeedLimit).toBe(true);
    expect(c.announcement).toBeNull();
    const d = nav.update(at(1.0, 35, 11000));
    expect(d.overSpeedLimit).toBe(false);
  });

  it('não corta a fala de um anúncio recente', () => {
    const nav = createNavigator(route([{ beginIdx: 0, endIdx: 10, kmh: 40 }]));
    nav.update(at(0.2, 30, 1000)); // anúncio de saída, ainda sendo falado
    nav.update(at(0.4, 60, 2000));
    const b = nav.update(at(0.6, 60, 3000));
    expect(b.overSpeedLimit).toBe(true);
    expect(b.announcement).toBeNull();
    // Passada a pausa, o aviso sai.
    expect(nav.update(at(0.8, 60, 8000)).announcement).toBe('Atenção: limite de 40 km/h');
  });

  it('com o fix longe da rota, não mostra limite', () => {
    const nav = createNavigator(route([{ beginIdx: 0, endIdx: 10, kmh: 40 }]));
    nav.update(at(2, 30, 1000));
    // ~110 m ao sul da reta, além da tolerância de 35 m, antes de declarar desvio.
    const s = nav.update({ t: 2000, lat: -23.561, lon: -46.648, speed: 10, accuracy: 5 });
    expect(s.offRoute).toBe(false);
    expect(s.speedLimitKmh).toBeNull();
    expect(s.overSpeedLimit).toBe(false);
  });
});
