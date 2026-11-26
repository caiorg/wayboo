import type { Route } from '../types';
import { logRatio, MIN_LEARN_BASE_S } from './stats';

/**
 * Trânsito ao vivo: o que quem tem opt-in mediu nos últimos 15 min, por trecho.
 *
 * Cada usuário conta uma vez por trecho, com a observação mais recente. O trecho só é publicado com
 * pelo menos `minUsers` usuários distintos na janela (k-anonimato), sem contar quem consulta: a medida
 * dele fica de fora, senão com `minUsers` 2 ele leria a de outra pessoa. Dentro da janela, o peso cai à
 * metade a cada 5 min. No ETA, o ao vivo puxa o histórico em direção ao observado agora, com mais
 * força quanto mais recente e numeroso, e perde efeito nos trechos alcançados mais tarde.
 */

export const LIVE_WINDOW_MS = 15 * 60_000;
export const LIVE_HALF_LIFE_MS = 5 * 60_000;
/** Um trecho alcançado 45 min depois do instante das observações já não usa o ao vivo. */
export const LIVE_HORIZON_MS = 45 * 60_000;
export const LIVE_MIN_USERS = 3;
/** Peso equivalente do histórico: com peso ao vivo `w`, o ao vivo leva `w / (w + 1)` do caminho. */
const LIVE_PRIOR_K = 1;

/** Observação guardada: o log da razão de um trecho e o instante, no relógio do servidor, em que o usuário saiu dele. */
export interface LiveObservation {
  seg: string;
  contributor: string;
  t: number;
  x: number;
}

export interface LiveSegment {
  /** Média ponderada do log da razão. */
  mean: number;
  /** Soma dos pesos (cada usuário vale até 1, menos quanto mais antiga a observação). */
  w: number;
  users: number;
}

export type LiveMap = Map<string, LiveSegment>;

/** Trechos publicados e o instante a que se referem. */
export interface LiveTraffic {
  segments: LiveMap;
  at: number;
}

/**
 * Converte as observações de um rastro em curso para a camada ao vivo.
 * O instante de saída do trecho vem da distância até a última amostra, no relógio do aparelho,
 * aplicada a `now` do servidor: um relógio de aparelho errado não desloca a janela.
 */
export function liveObservations(
  route: Route,
  observations: { index: number; enteredAt: number; durationS: number }[],
  lastSampleT: number,
  now: number,
): { seg: string; t: number; x: number }[] {
  const out: { seg: string; t: number; x: number }[] = [];
  for (const o of observations) {
    const seg = route.segments[o.index];
    if (!seg || seg.baseDurationS < MIN_LEARN_BASE_S || o.durationS <= 0) continue;
    const exitAt = o.enteredAt + o.durationS * 1000;
    const t = now - Math.max(0, lastSampleT - exitAt);
    if (t < now - LIVE_WINDOW_MS) continue;
    out.push({ seg: seg.key, t: Math.round(t), x: logRatio(o.durationS, seg.baseDurationS) });
  }
  return out;
}

/**
 * Agrega as observações da janela que termina em `now`, sem as de `exclude` (quem consulta).
 * Trechos com menos de `minUsers` usuários ficam de fora.
 */
export function aggregateLive(observations: LiveObservation[], now: number, minUsers = LIVE_MIN_USERS, exclude?: string): LiveMap {
  const latest = new Map<string, Map<string, LiveObservation>>();
  for (const o of observations) {
    if (o.contributor === exclude || o.t > now || o.t < now - LIVE_WINDOW_MS) continue;
    let bySeg = latest.get(o.seg);
    if (!bySeg) latest.set(o.seg, (bySeg = new Map()));
    const prev = bySeg.get(o.contributor);
    if (!prev || o.t > prev.t) bySeg.set(o.contributor, o);
  }
  const out: LiveMap = new Map();
  for (const [seg, bySeg] of latest) {
    if (bySeg.size < minUsers) continue;
    let w = 0;
    let sum = 0;
    for (const o of bySeg.values()) {
      const weight = 0.5 ** ((now - o.t) / LIVE_HALF_LIFE_MS);
      w += weight;
      sum += weight * o.x;
    }
    out.set(seg, { mean: sum / w, w, users: bySeg.size });
  }
  return out;
}

/**
 * Fração (0..1) do caminho entre o histórico e o ao vivo para um trecho alcançado em `entryAt`:
 * `mean = hist + alpha · (live.mean − hist)`.
 */
export function liveAlpha(live: LiveSegment, entryAt: number, at: number): number {
  const fade = 1 - Math.abs(entryAt - at) / LIVE_HORIZON_MS;
  return fade <= 0 ? 0 : (fade * live.w) / (live.w + LIVE_PRIOR_K);
}
