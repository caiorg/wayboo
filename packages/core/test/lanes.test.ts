import { describe, expect, it } from 'vitest';
import { LANE_GUIDANCE_RANGE_M, laneGuidance, laneIndications, parseValhallaLanes, upcomingLanes } from '../src/lanes';
import type { Maneuver } from '../src/types';

describe('faixas: parse do Valhalla', () => {
  it('mantém directions, active e valid das faixas', () => {
    expect(
      parseValhallaLanes([
        { directions: 8, active: 8 },
        { directions: 10, valid: 8 },
        { directions: 2 },
      ]),
    ).toEqual([{ directions: 8, active: 8 }, { directions: 10, valid: 8 }, { directions: 2 }]);
  });

  it('sem array ou com menos de duas faixas, não há faixas', () => {
    expect(parseValhallaLanes(undefined)).toBeUndefined();
    expect(parseValhallaLanes('x')).toBeUndefined();
    expect(parseValhallaLanes([])).toBeUndefined();
    expect(parseValhallaLanes([{ directions: 2 }])).toBeUndefined();
  });

  it('descarta a lista inteira se uma faixa vier malformada', () => {
    // Tirar uma faixa do meio mudaria a posição das outras.
    expect(parseValhallaLanes([{ directions: 8 }, { directions: -1 }])).toBeUndefined();
    expect(parseValhallaLanes([{ directions: 8 }, { directions: 2.5 }])).toBeUndefined();
    expect(parseValhallaLanes([{ directions: 8 }, null])).toBeUndefined();
    expect(parseValhallaLanes([{ directions: 8, active: 'x' }, { directions: 2 }])).toBeUndefined();
  });

  it('ignora campos que o app não usa', () => {
    expect(parseValhallaLanes([{ directions: 8, extra: 1 }, { directions: 2 }])).toEqual([{ directions: 8 }, { directions: 2 }]);
  });
});

describe('faixas: indicações', () => {
  it('traduz a bitmask na ordem da esquerda para a direita', () => {
    expect(laneIndications(8 | 2)).toEqual(['left', 'through']);
    expect(laneIndications(2 | 32 | 64)).toEqual(['through', 'slight-right', 'right']);
    expect(laneIndications(256)).toEqual(['uturn']);
    expect(laneIndications(512)).toEqual(['merge-left']);
  });

  it('faixa sem marcação (0 ou 1) não tem indicação', () => {
    expect(laneIndications(0)).toEqual([]);
    expect(laneIndications(1)).toEqual([]);
  });
});

describe('faixas: regras de exibição', () => {
  it('marca a faixa ativa, a válida e as demais', () => {
    expect(laneGuidance([{ directions: 8, active: 8 }, { directions: 10, valid: 8 }, { directions: 2 }])).toEqual([
      { indications: ['left'], state: 'active', use: 'left' },
      { indications: ['left', 'through'], state: 'valid', use: 'left' },
      { indications: ['through'], state: 'other', use: null },
    ]);
  });

  it('sem active nem valid, mostra as faixas sem destaque', () => {
    expect(laneGuidance([{ directions: 8 }, { directions: 2 }])).toEqual([
      { indications: ['left'], state: 'other', use: null },
      { indications: ['through'], state: 'other', use: null },
    ]);
  });

  it('não mostra nada se nenhuma faixa tiver seta', () => {
    expect(laneGuidance([{ directions: 1 }, { directions: 0 }])).toBeNull();
    expect(laneGuidance(undefined)).toBeNull();
  });

  const maneuver = (lanes?: Maneuver['lanes']): Maneuver => ({
    type: 15,
    instruction: 'Vire à esquerda',
    streetNames: [],
    distanceM: 100,
    durationS: 10,
    beginIdx: 0,
    endIdx: 1,
    toll: false,
    highway: false,
    lanes,
  });

  const nav = (nextManeuver: Maneuver | null, distanceToManeuverM: number, offRoute = false) => ({ nextManeuver, distanceToManeuverM, offRoute });

  it('mostra as faixas da próxima manobra só perto dela', () => {
    const m = maneuver([{ directions: 8, active: 8 }, { directions: 2 }]);
    expect(upcomingLanes(nav(m, LANE_GUIDANCE_RANGE_M))).toHaveLength(2);
    expect(upcomingLanes(nav(m, LANE_GUIDANCE_RANGE_M + 1))).toBeNull();
    expect(upcomingLanes(nav(maneuver(), 10))).toBeNull();
    expect(upcomingLanes(nav(null, 10))).toBeNull();
  });

  it('fora da rota não mostra as faixas da rota antiga', () => {
    const m = maneuver([{ directions: 8, active: 8 }, { directions: 2 }]);
    expect(upcomingLanes(nav(m, 100, true))).toBeNull();
  });
});
