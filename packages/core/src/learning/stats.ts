import type { DayType } from '../types';
import { holidayCalendarFor, type HolidayCalendar } from './holidays';

/**
 * Média e variância ponderadas com decaimento exponencial.
 * Uma observação de `halfLifeDays` atrás vale metade de uma observação de hoje,
 * então o modelo acompanha mudanças (obra nova, mudança de emprego) sem esquecer tudo.
 */
export interface DecayedStat {
  w: number;
  mean: number;
  m2: number;
  /** epoch ms da última atualização */
  t: number;
}

export const DEFAULT_HALF_LIFE_DAYS = 45;
const DAY_MS = 86_400_000;

export function decayed(s: DecayedStat, now: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): DecayedStat {
  const age = Math.max(0, now - s.t);
  const f = 0.5 ** (age / (halfLifeDays * DAY_MS));
  return { w: s.w * f, mean: s.mean, m2: s.m2 * f, t: now };
}

export function observe(
  s: DecayedStat | undefined,
  x: number,
  now: number,
  weight = 1,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): DecayedStat {
  const base = s ? decayed(s, now, halfLifeDays) : { w: 0, mean: 0, m2: 0, t: now };
  const w = base.w + weight;
  const delta = x - base.mean;
  const mean = base.mean + (weight * delta) / w;
  const m2 = base.m2 + weight * delta * (x - mean);
  return { w, mean, m2, t: now };
}

export function variance(s: DecayedStat): number {
  return s.w > 0 ? s.m2 / s.w : 0;
}

export interface Shrunk {
  mean: number;
  variance: number;
  /** Peso efetivo das observações (após decaimento) */
  w: number;
}

/**
 * Encolhimento bayesiano: com poucas observações o resultado fica perto do prior;
 * com muitas, perto da média observada. `k` é o peso equivalente do prior.
 */
export function shrink(
  s: DecayedStat | undefined,
  prior: Shrunk,
  k: number,
  now: number,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): Shrunk {
  if (!s || s.w <= 0) return { ...prior, w: 0 };
  const d = decayed(s, now, halfLifeDays);
  const total = d.w + k;
  return {
    mean: (d.w * d.mean + k * prior.mean) / total,
    variance: (d.w * variance(d) + k * prior.variance) / total,
    w: d.w,
  };
}

/** Combina várias estatísticas com pesos (ex.: bins vizinhos de horário). */
export function pool(stats: { s: DecayedStat | undefined; weight: number }[], now: number): DecayedStat | undefined {
  let w = 0;
  let sum = 0;
  let sumSq = 0;
  for (const { s, weight } of stats) {
    if (!s) continue;
    const d = decayed(s, now);
    const ww = d.w * weight;
    w += ww;
    sum += ww * d.mean;
    sumSq += weight * (d.m2 + d.w * d.mean * d.mean);
  }
  if (w <= 0) return undefined;
  const mean = sum / w;
  return { w, mean, m2: Math.max(0, sumSq - w * mean * mean), t: now };
}

/** Trechos com tempo base menor que isso não aprendem: a razão fica dominada pelo ruído do GPS. */
export const MIN_LEARN_BASE_S = 2;

/** Log da razão `observado / base`, limitado para uma medida ruim não dominar a média. */
export const logRatio = (observedS: number, baseS: number) => Math.max(-1.2, Math.min(2.5, Math.log(observedS / baseS)));

// ---------- tempo local ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalTime {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
  /** Dia da semana real (0 = domingo), mesmo em feriado. */
  dow: number;
  minuteOfDay: number;
  /** Feriado conta como domingo: o trânsito se parece mais com o de domingo que com o de dia útil. */
  dayType: DayType;
  /** Nome do feriado, ou null. */
  holiday: string | null;
  /** Bin de 30 min (0..47) */
  bin: number;
}

export const BIN_MINUTES = 30;
export const BINS_PER_DAY = (24 * 60) / BIN_MINUTES;

/**
 * Converte um instante para o tempo local do fuso.
 * `calendar` define os feriados; o padrão vem do fuso (nacional brasileiro nos fusos do Brasil).
 */
export function localTime(
  epochMs: number,
  timeZone: string,
  calendar: HolidayCalendar = holidayCalendarFor(timeZone),
): LocalTime {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  const dow = WEEKDAYS[parts.weekday ?? 'Mon'] ?? 1;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  const date = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
  const holiday = calendar(date);
  return {
    ...date,
    dow,
    minuteOfDay,
    dayType: holiday || dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday',
    holiday,
    bin: Math.floor(minuteOfDay / BIN_MINUTES),
  };
}

export function binLabel(bin: number): string {
  const m = bin * BIN_MINUTES;
  const pad = (n: number) => String(n).padStart(2, '0');
  const end = m + BIN_MINUTES;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}–${pad(Math.floor(end / 60) % 24)}:${pad(end % 60)}`;
}

export const DAY_TYPE_LABEL: Record<DayType, string> = {
  weekday: 'dias úteis',
  saturday: 'sábados',
  sunday: 'domingos',
};
