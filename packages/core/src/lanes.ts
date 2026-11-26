import type { NavState } from './navigation';

/**
 * Faixa da via antes de uma manobra, como o Valhalla devolve com `turn_lanes: true`. Os três campos são
 * bitmasks do enum de direções do Valhalla (ver `LANE_BITS`). A lista vem da esquerda para a direita,
 * na ordem da tag `turn:lanes` do OSM.
 */
export interface Lane {
  /** Direções que a faixa permite. */
  directions: number;
  /** Direção da manobra para a qual esta é a melhor faixa (sem trocar de faixa depois). */
  active?: number;
  /** Direção da manobra que esta faixa também atende, talvez com troca de faixa depois. */
  valid?: number;
}

export type LaneIndication =
  | 'uturn'
  | 'sharp-left'
  | 'left'
  | 'slight-left'
  | 'merge-left'
  | 'through'
  | 'merge-right'
  | 'slight-right'
  | 'right'
  | 'sharp-right';

/** Bits do Valhalla, na ordem em que as setas aparecem da esquerda para a direita. 0 e 1 (sem marcação) ficam de fora. */
const LANE_BITS: [number, LaneIndication][] = [
  [256, 'uturn'],
  [4, 'sharp-left'],
  [8, 'left'],
  [16, 'slight-left'],
  [512, 'merge-left'],
  [2, 'through'],
  [1024, 'merge-right'],
  [32, 'slight-right'],
  [64, 'right'],
  [128, 'sharp-right'],
];

/**
 * Distância até a manobra a partir da qual o app mostra as faixas dela. As faixas descrevem só a via logo
 * antes da manobra; mais longe, o carro pode estar num trecho com outras faixas.
 */
export const LANE_GUIDANCE_RANGE_M = 800;

const isMask = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * Valida o `lanes` de uma manobra do Valhalla. Devolve `undefined` se faltar, tiver menos de duas faixas
 * ou se alguma faixa vier malformada: descartar só a faixa ruim mudaria a posição das outras.
 */
export function parseValhallaLanes(raw: unknown): Lane[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined;
  const lanes: Lane[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { directions, active, valid } = item as Record<string, unknown>;
    if (!isMask(directions)) return undefined;
    if (active !== undefined && !isMask(active)) return undefined;
    if (valid !== undefined && !isMask(valid)) return undefined;
    const lane: Lane = { directions };
    if (active !== undefined) lane.active = active;
    if (valid !== undefined) lane.valid = valid;
    lanes.push(lane);
  }
  return lanes;
}

/** Setas de uma bitmask, da esquerda para a direita. Faixa sem marcação devolve lista vazia. */
export function laneIndications(mask: number): LaneIndication[] {
  return LANE_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
}

export interface LaneView {
  indications: LaneIndication[];
  /** `active`: melhor faixa para a manobra; `valid`: também serve; `other`: não serve ou o dado não diz. */
  state: 'active' | 'valid' | 'other';
  /** Seta a destacar na faixa, quando o roteador diz qual direção dela segue a rota. */
  use: LaneIndication | null;
}

/**
 * O que mostrar das faixas de uma manobra. Usa só o que veio do roteador: sem `active`/`valid`, nenhuma
 * faixa recebe destaque. Devolve null se não houver faixas ou se nenhuma tiver seta.
 */
export function laneGuidance(lanes: Lane[] | undefined): LaneView[] | null {
  if (!lanes || lanes.length < 2) return null;
  const views = lanes.map((l): LaneView => {
    const indications = laneIndications(l.directions);
    if (l.active) return { indications, state: 'active', use: laneIndications(l.active)[0] ?? null };
    if (l.valid) return { indications, state: 'valid', use: laneIndications(l.valid)[0] ?? null };
    return { indications, state: 'other', use: null };
  });
  return views.some((v) => v.indications.length > 0) ? views : null;
}

/** Faixas da próxima manobra, só quando ela está a até `LANE_GUIDANCE_RANGE_M` e o carro segue na rota. */
export function upcomingLanes(nav: Pick<NavState, 'nextManeuver' | 'distanceToManeuverM' | 'offRoute'>): LaneView[] | null {
  if (!nav.nextManeuver || nav.offRoute || nav.distanceToManeuverM > LANE_GUIDANCE_RANGE_M) return null;
  return laneGuidance(nav.nextManeuver.lanes);
}
