import type { SpeedLimitSpan } from './types';

/**
 * Margem acima do limite antes de avisar. Cobre o ruído da velocidade do GPS. Não é a tolerância legal
 * dos radares, que é maior.
 */
export const SPEED_LIMIT_TOLERANCE_KMH = 2;

/** Limites acima disso são erro de dado, não placa. */
const MAX_PLAUSIBLE_KMH = 200;

const isIndex = (v: unknown, len: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < len;

/**
 * Converte as arestas do `/trace_attributes` do Valhalla (`edge.speed_limit`, `edge.begin_shape_index`,
 * `edge.end_shape_index`) em trechos com limite conhecido, nos índices do shape da perna. Aresta sem
 * `speed_limit` (o OSM não tem `maxspeed`), com `"unlimited"` ou com valor implausível fica de fora.
 * Devolve `undefined` se a resposta não bater com o shape (índices fora dele ou fora de ordem).
 */
export function parseValhallaSpeedLimits(edges: unknown, shapeLength: number): SpeedLimitSpan[] | undefined {
  if (!Array.isArray(edges)) return undefined;
  const spans: SpeedLimitSpan[] = [];
  let lastEnd = 0;
  for (const e of edges) {
    if (typeof e !== 'object' || e === null) return undefined;
    const { speed_limit, begin_shape_index: begin, end_shape_index: end } = e as Record<string, unknown>;
    if (!isIndex(begin, shapeLength) || !isIndex(end, shapeLength) || end < begin || begin < lastEnd) return undefined;
    lastEnd = end;
    if (typeof speed_limit !== 'number' || !Number.isInteger(speed_limit) || speed_limit <= 0 || speed_limit > MAX_PLAUSIBLE_KMH) continue;
    appendSpeedLimits(spans, [{ beginIdx: begin, endIdx: end, kmh: speed_limit }], 0);
  }
  return spans;
}

/**
 * Acrescenta a `target` os trechos de um pedaço do shape que começa no índice `offset`, juntando o
 * primeiro ao último de `target` quando são vizinhos e têm o mesmo limite.
 */
export function appendSpeedLimits(target: SpeedLimitSpan[], spans: SpeedLimitSpan[], offset: number): void {
  for (const s of spans) {
    const beginIdx = s.beginIdx + offset;
    const endIdx = s.endIdx + offset;
    const prev = target[target.length - 1];
    if (prev && prev.endIdx === beginIdx && prev.kmh === s.kmh) prev.endIdx = endIdx;
    else target.push({ beginIdx, endIdx, kmh: s.kmh });
  }
}

/** Trecho com limite que contém o trecho `segmentIdx` da polyline (do ponto `segmentIdx` ao seguinte). */
export function speedLimitSpanAt(spans: SpeedLimitSpan[] | undefined, segmentIdx: number): SpeedLimitSpan | null {
  return spans?.find((s) => segmentIdx >= s.beginIdx && segmentIdx < s.endIdx) ?? null;
}

/** Limite no trecho `segmentIdx` da polyline, ou null se não houver dado. */
export function speedLimitAt(spans: SpeedLimitSpan[] | undefined, segmentIdx: number): number | null {
  return speedLimitSpanAt(spans, segmentIdx)?.kmh ?? null;
}

/** Velocidade (m/s, do GPS) acima do limite mais a margem. Sem velocidade ou sem limite, não avisa. */
export function isOverSpeedLimit(speedMs: number | null | undefined, limitKmh: number | null): boolean {
  if (speedMs == null || limitKmh === null) return false;
  return speedMs * 3.6 > limitKmh + SPEED_LIMIT_TOLERANCE_KMH;
}
