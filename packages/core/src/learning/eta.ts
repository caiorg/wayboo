import type { DayType, EtaEstimate, EtaFactor, Route, TripContext } from '../types';
import {
  BIN_MINUTES,
  BINS_PER_DAY,
  localTime,
  observe,
  pool,
  shrink,
  type DecayedStat,
  type Shrunk,
} from './stats';

/**
 * Modelo de ETA aprendido.
 *
 * O roteador dá um tempo base por trecho (velocidade de via, sem trânsito real).
 * O modelo aprende o log da razão `tempo observado / tempo base` em vários níveis:
 *
 *   trecho × tipo de dia × horário (do usuário)
 *     → trecho × tipo de dia × horário (de todos os usuários, "crowd")
 *       → trecho × tipo de dia em qualquer horário (usuário, depois crowd)
 *         → trecho no outro dia de fim de semana, com peso menor (só sábado e domingo)
 *           → padrão geral do usuário naquele tipo de dia e horário
 *             → 0 (confia no roteador)
 *
 * Cada nível encolhe em direção ao de baixo quando tem poucas observações.
 * Dia útil nunca entra no fim de semana nem o contrário: sem viagens de domingo, o domingo
 * não herda o pico dos dias úteis. Sábado e domingo emprestam um ao outro.
 * Por cima disso entram fatores de contexto aprendidos (chuva, visibilidade,
 * alertas) e um resíduo por rotina origem→destino (ex.: tempo para estacionar).
 */

export type StatsMap = Map<string, DecayedStat>;
export type ContextFlag = 'rain' | 'heavy_rain' | 'low_visibility' | 'alerts';

export const statKey = {
  segBin: (seg: string, d: DayType, bin: number) => `sb|${seg}|${d}|${bin}`,
  /** Trecho em qualquer dia e horário. O ETA não usa (mistura tipos de dia); serve para familiaridade e contagem. */
  seg: (seg: string) => `s|${seg}`,
  global: (d: DayType, bin: number) => `g|${d}|${bin}`,
  ctx: (f: ContextFlag) => `c|${f}`,
  od: (origin: string, dest: string) => `od|${origin}|${dest}`,
};

/** Segmento ao qual a chave pertence (para indexar no banco), ou null para chaves globais. */
export function segmentOfKey(key: string): string | null {
  const [kind, seg] = key.split('|');
  return kind === 'sb' || kind === 's' ? (seg ?? null) : null;
}

const CONTEXT_PRIOR: Record<ContextFlag, number> = {
  rain: Math.log(1.08),
  heavy_rain: Math.log(1.2),
  low_visibility: Math.log(1.05),
  alerts: Math.log(1.03),
};

const CONTEXT_LABEL: Record<ContextFlag, string> = {
  rain: 'Chuva',
  heavy_rain: 'Chuva forte',
  low_visibility: 'Baixa visibilidade',
  alerts: 'Alertas na rota',
};

export function activeFlags(ctx: TripContext): ContextFlag[] {
  const flags: ContextFlag[] = [];
  if (ctx.heavyRain) flags.push('heavy_rain');
  else if (ctx.rain) flags.push('rain');
  if (ctx.lowVisibility) flags.push('low_visibility');
  if (ctx.alertsOnRoute > 0) flags.push('alerts');
  return flags;
}

const ROOT: Shrunk = { mean: 0, variance: 0.05, w: 0 };

/** Outro dia de fim de semana. Dia útil não tem vizinho. */
const WEEKEND_SIBLING: Partial<Record<DayType, DayType>> = { saturday: 'sunday', sunday: 'saturday' };
/** Uma observação do outro dia de fim de semana vale metade de uma do próprio dia. */
export const WEEKEND_SIBLING_WEIGHT = 0.5;
const MIN_LEARN_BASE_S = 2;

export interface EtaInput {
  route: Route;
  departAt: number;
  timeZone: string;
  user: StatsMap;
  crowd: StatsMap;
  ctx: TripContext;
  /** Chave od|origem|destino quando origem e destino são lugares conhecidos. */
  odKey?: string | null;
  /** Atraso adicional estimado pelos alertas ativos à frente (s). */
  alertPenaltyS?: number;
}

interface SegmentEstimate {
  mean: number;
  variance: number;
  userW: number;
  crowdW: number;
}

function neighbors(map: StatsMap, seg: string, d: DayType, bin: number) {
  const prev = (bin - 1 + BINS_PER_DAY) % BINS_PER_DAY;
  const next = (bin + 1) % BINS_PER_DAY;
  return [
    { s: map.get(statKey.segBin(seg, d, bin)), weight: 1 },
    { s: map.get(statKey.segBin(seg, d, prev)), weight: 0.35 },
    { s: map.get(statKey.segBin(seg, d, next)), weight: 0.35 },
  ];
}

/** Trecho × tipo de dia em qualquer horário: soma de todos os bins do dia, sem chave própria no banco. */
function dayStat(map: StatsMap, seg: string, d: DayType, now: number) {
  return pool(
    Array.from({ length: BINS_PER_DAY }, (_, bin) => ({ s: map.get(statKey.segBin(seg, d, bin)), weight: 1 })),
    now,
  );
}

function globalPrior(user: StatsMap, d: DayType, bin: number, now: number): Shrunk {
  const pooled = pool(
    [
      { s: user.get(statKey.global(d, bin)), weight: 1 },
      { s: user.get(statKey.global(d, (bin + 1) % BINS_PER_DAY)), weight: 0.5 },
      { s: user.get(statKey.global(d, (bin - 1 + BINS_PER_DAY) % BINS_PER_DAY)), weight: 0.5 },
    ],
    now,
  );
  return shrink(pooled, ROOT, 6, now);
}

export function estimateSegment(
  seg: string,
  d: DayType,
  bin: number,
  user: StatsMap,
  crowd: StatsMap,
  now: number,
): SegmentEstimate {
  const g = globalPrior(user, d, bin, now);
  const sib = WEEKEND_SIBLING[d];
  const sibling = sib
    ? shrink(
        pool(
          [
            { s: dayStat(user, seg, sib, now), weight: WEEKEND_SIBLING_WEIGHT },
            { s: dayStat(crowd, seg, sib, now), weight: WEEKEND_SIBLING_WEIGHT },
          ],
          now,
        ),
        g,
        1,
        now,
      )
    : g;
  const crowdSeg = shrink(dayStat(crowd, seg, d, now), sibling, 4, now);
  const userSeg = shrink(dayStat(user, seg, d, now), crowdSeg, 3, now);
  const crowdBin = shrink(pool(neighbors(crowd, seg, d, bin), now), userSeg, 3, now);
  const userBin = shrink(pool(neighbors(user, seg, d, bin), now), crowdBin, 2, now);
  return {
    mean: userBin.mean,
    variance: userBin.variance,
    userW: userBin.w + 0.5 * userSeg.w,
    crowdW: crowdBin.w + 0.5 * crowdSeg.w,
  };
}

export function predictEta(input: EtaInput): EtaEstimate {
  const { route, departAt, timeZone, user, crowd, ctx } = input;
  const now = departAt;
  const lt = localTime(departAt, timeZone);
  let elapsed = 0;
  let sigmaWeighted = 0;
  let confWeighted = 0;
  const segmentDurationsS: number[] = [];

  for (const s of route.segments) {
    const minute = (lt.minuteOfDay + elapsed / 60) % (24 * 60);
    const bin = Math.floor(minute / BIN_MINUTES);
    const est = estimateSegment(s.key, lt.dayType, bin, user, crowd, now);
    const dur = s.baseDurationS * Math.exp(est.mean);
    segmentDurationsS.push(dur);
    elapsed += dur;
    sigmaWeighted += dur * Math.sqrt(est.variance);
    confWeighted += dur * Math.min(1, (est.userW + 0.5 * est.crowdW) / 4);
  }

  const segTotal = elapsed;
  const factors: EtaFactor[] = [];
  const learnedDelta = segTotal - route.baseDurationS;
  if (Math.abs(learnedDelta) >= 30) {
    factors.push({
      kind: 'segments',
      label: learnedDelta > 0 ? 'Trânsito típico deste horário nos trechos' : 'Trechos costumam fluir melhor que o previsto',
      deltaS: learnedDelta,
    });
  }

  let logMult = 0;
  let ctxVar = 0;
  for (const f of activeFlags(ctx)) {
    const pooled = pool(
      [
        { s: user.get(statKey.ctx(f)), weight: 1 },
        { s: crowd.get(statKey.ctx(f)), weight: 0.5 },
      ],
      now,
    );
    const est = shrink(pooled, { mean: CONTEXT_PRIOR[f], variance: 0.02, w: 0 }, 3, now);
    const scaled = f === 'alerts' ? est.mean * Math.min(3, ctx.alertsOnRoute) : est.mean;
    logMult += scaled;
    ctxVar += est.variance;
    factors.push({ kind: 'context', label: CONTEXT_LABEL[f], deltaS: segTotal * (Math.exp(scaled) - 1) });
  }

  if (input.odKey) {
    const est = shrink(user.get(input.odKey), { mean: 0, variance: 0.01, w: 0 }, 2, now);
    if (est.w > 0) {
      logMult += est.mean;
      const delta = segTotal * (Math.exp(est.mean) - 1);
      if (Math.abs(delta) >= 30) {
        factors.push({ kind: 'routine', label: 'Ajuste da sua rotina neste trajeto', deltaS: delta });
      }
    }
  }

  const penalty = input.alertPenaltyS ?? 0;
  if (penalty > 0) factors.push({ kind: 'alerts', label: 'Alertas da comunidade à frente', deltaS: penalty });

  const durationS = segTotal * Math.exp(logMult) + penalty;
  // Trechos de uma mesma viagem têm atrasos correlacionados: usamos a média
  // ponderada dos desvios (correlação perfeita) amortecida em 0,7.
  const sigma = Math.sqrt((sigmaWeighted / Math.max(1, segTotal)) ** 2 * 0.7 + ctxVar);
  const z = 1.2816;
  return {
    durationS,
    p10S: durationS * Math.exp(-z * sigma),
    p90S: durationS * Math.exp(z * sigma),
    baseDurationS: route.baseDurationS,
    confidence: confWeighted / Math.max(1, segTotal),
    factors,
    segmentDurationsS,
  };
}

export interface SegmentObservation {
  index: number;
  /** epoch ms de entrada no trecho */
  enteredAt: number;
  durationS: number;
}

export interface LearnInput {
  route: Route;
  observations: SegmentObservation[];
  departAt: number;
  timeZone: string;
  user: StatsMap;
  crowd: StatsMap;
  ctx: TripContext;
  odKey?: string | null;
  /** Duração real ponta a ponta, só quando a viagem chegou ao destino da rota. */
  actualTotalS?: number | null;
}

export interface Anomaly {
  segmentKey: string;
  index: number;
  expectedS: number;
  observedS: number;
}

export interface LearnResult {
  user: StatsMap;
  crowd: StatsMap;
  anomalies: Anomaly[];
  learnedSegments: number;
}

const clampLog = (x: number) => Math.max(-1.2, Math.min(2.5, x));

const DAY_MS = 86_400_000;
/**
 * O agregado guarda só o dia (UTC) da última atualização, nunca o horário exato em que alguém passou
 * pelo trecho. O horário aparece só como faixa de 30 min na chave. Com meia-vida de 45 dias, a perda
 * de precisão no decaimento é desprezível.
 */
export const crowdTime = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/** Atualiza as estatísticas com o que foi observado na viagem. Não muta os mapas de entrada. */
export function learnFromTrip(input: LearnInput): LearnResult {
  const { route, observations, timeZone, ctx } = input;
  const user: StatsMap = new Map();
  const crowd: StatsMap = new Map();
  const getU = (k: string) => user.get(k) ?? input.user.get(k);
  const getC = (k: string) => crowd.get(k) ?? input.crowd.get(k);
  const anomalies: Anomaly[] = [];

  // Previsão só por trechos, com o conhecimento de antes da viagem (para resíduo e anomalias).
  const before = predictEta({
    route,
    departAt: input.departAt,
    timeZone,
    user: input.user,
    crowd: input.crowd,
    ctx: { rain: false, heavyRain: false, lowVisibility: false, alertsOnRoute: 0 },
  });

  let learned = 0;
  for (const o of observations) {
    const seg = route.segments[o.index];
    if (!seg || seg.baseDurationS < MIN_LEARN_BASE_S || o.durationS <= 0) continue;
    const x = clampLog(Math.log(o.durationS / seg.baseDurationS));
    const lt = localTime(o.enteredAt, timeZone);
    const now = o.enteredAt;
    const weight = Math.min(1, seg.baseDurationS / 20);
    for (const [get, put, t] of [
      [getU, user, now],
      [getC, crowd, crowdTime(now)],
    ] as const) {
      const kb = statKey.segBin(seg.key, lt.dayType, lt.bin);
      const ks = statKey.seg(seg.key);
      put.set(kb, observe(get(kb), x, t));
      put.set(ks, observe(get(ks), x, t));
    }
    const kg = statKey.global(lt.dayType, lt.bin);
    user.set(kg, observe(getU(kg), x, now, weight));
    learned++;

    const expected = before.segmentDurationsS[o.index] ?? seg.baseDurationS;
    if (o.durationS > expected * 1.6 && o.durationS - expected > 45) {
      anomalies.push({ segmentKey: seg.key, index: o.index, expectedS: expected, observedS: o.durationS });
    }
  }

  if (input.actualTotalS && input.actualTotalS > 0 && before.durationS > 0) {
    const residual = clampLog(Math.log(input.actualTotalS / before.durationS));
    const flags = activeFlags(ctx);
    const now = input.departAt;
    if (flags.length) {
      for (const f of flags) {
        const k = statKey.ctx(f);
        user.set(k, observe(getU(k), residual, now));
        crowd.set(k, observe(getC(k), residual, crowdTime(now), 0.5));
      }
    } else if (input.odKey) {
      user.set(input.odKey, observe(getU(input.odKey), residual, now));
    }
  }

  return { user, crowd, anomalies, learnedSegments: learned };
}

/** ETA para várias opções de horário de saída (para "melhor hora de sair"). */
export function departureOptions(
  base: Omit<EtaInput, 'departAt'>,
  from: number,
  offsetsMin: number[],
): { departAt: number; durationS: number; p90S: number }[] {
  return offsetsMin.map((off) => {
    const departAt = from + off * 60_000;
    const e = predictEta({ ...base, departAt });
    return { departAt, durationS: e.durationS, p90S: e.p90S };
  });
}
