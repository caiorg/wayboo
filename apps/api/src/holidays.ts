import { readFileSync } from 'node:fs';
import {
  easterSunday,
  geohash,
  geohashCenter,
  holidayCalendarFor,
  noHolidays,
  type HolidayCalendar,
  type HolidayRegion,
  type LatLon,
  type LocalDate,
} from '@wayboo/core';
import { z } from 'zod';
import { config } from './config';
import { fetchJson, ttlCache } from './providers/http';

/**
 * Feriados estaduais e municipais, gerados por `src/scripts/holidays-import.ts` a partir de
 * https://github.com/joaopbini/feriados-brasil (MIT, ver `src/data/NOTICE.md`).
 */
export interface HolidayData {
  source: { repo: string; commit: string; license: string; years: [number, number] };
  /** UF → nome do estado */
  states: Record<string, string>;
  /** UF → nome do município → código IBGE. Só municípios com feriado próprio. */
  municipalities: Record<string, Record<string, number>>;
  /**
   * UF ou código IBGE → [regra, nome]. A regra é `MM-DD` (todo ano), `E+N`/`E-N` (dias a partir do
   * domingo de Páscoa) ou `AAAA-MM-DD` (só naquele ano: feriado que já mudou de data, como os transferidos).
   */
  holidays: Record<string, [string, string][]>;
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface Index {
  data: HolidayData;
  ufByState: Map<string, string>;
  ibgeByCity: Map<string, number>;
}

let index: Index | undefined;
function load(): Index {
  if (index) return index;
  const data = JSON.parse(readFileSync(new URL('./data/holidays-br.json', import.meta.url), 'utf8')) as HolidayData;
  const ufByState = new Map(Object.entries(data.states).map(([uf, name]) => [normalize(name), uf]));
  const ibgeByCity = new Map<string, number>();
  for (const [uf, cities] of Object.entries(data.municipalities)) {
    for (const [name, ibge] of Object.entries(cities)) ibgeByCity.set(`${uf}|${normalize(name)}`, ibge);
  }
  index = { data, ufByState, ibgeByCity };
  return index;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: LocalDate) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

function resolveRule(rule: string, year: number): string | null {
  if (rule.length === 5) return `${year}-${rule}`;
  if (rule.startsWith('E')) {
    const e = easterSunday(year);
    const t = new Date(Date.UTC(e.year, e.month - 1, e.day + Number(rule.slice(1))));
    return dateKey({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
  }
  return rule.startsWith(`${year}-`) ? rule : null;
}

const byScopeYear = new Map<string, Map<string, string>>();
function scopeHoliday(scope: string, date: LocalDate): string | null {
  const k = `${scope}|${date.year}`;
  let map = byScopeYear.get(k);
  if (!map) {
    map = new Map();
    for (const [rule, name] of load().data.holidays[scope] ?? []) {
      const day = resolveRule(rule, date.year);
      if (day && !map.has(day)) map.set(day, name);
    }
    byScopeYear.set(k, map);
  }
  return map.get(dateKey(date)) ?? null;
}

/** Calendário do fuso (nacional no Brasil) mais os feriados do estado e do município da região. */
export function regionalCalendar(timeZone: string, region: HolidayRegion | null | undefined): HolidayCalendar {
  const base = holidayCalendarFor(timeZone);
  if (!region || base === noHolidays) return base;
  const scopes = region.ibge === null ? [region.uf] : [region.uf, String(region.ibge)];
  return (date) => {
    const national = base(date);
    if (national) return national;
    for (const s of scopes) {
      const name = scopeHoliday(s, date);
      if (name) return name;
    }
    return null;
  };
}

const PhotonReverse = z.object({
  features: z.array(
    z.object({
      properties: z
        .object({ countrycode: z.string().optional(), state: z.string().optional(), city: z.string().optional(), county: z.string().optional() })
        .optional(),
    }),
  ),
});
type PhotonAddress = NonNullable<z.output<typeof PhotonReverse>['features'][number]['properties']>;

function toRegion(p: PhotonAddress | undefined): HolidayRegion | null {
  if (!p || p.countrycode?.toUpperCase() !== 'BR' || !p.state) return null;
  const { ufByState, ibgeByCity } = load();
  const uf = ufByState.get(normalize(p.state));
  if (!uf) return null;
  for (const name of [p.city, p.county]) {
    const ibge = name ? ibgeByCity.get(`${uf}|${normalize(name)}`) : undefined;
    if (ibge !== undefined) return { uf, ibge };
  }
  return { uf, ibge: null };
}

/** Célula geohash de ~1,2 × 0,6 km: o Photon recebe só o centro dela, nunca a coordenada exata. */
const CELL_PRECISION = 6;
const regionCache = ttlCache<HolidayRegion | null>(7 * 86_400_000, 5000);
/** Falha recente do Photon: evita esperar o timeout a cada plano enquanto ele estiver fora. */
const failedCells = ttlCache<true>(10 * 60_000, 5000);

export function clearHolidayRegionCache() {
  regionCache.clear();
  failedCells.clear();
}

/**
 * Estado e município do ponto, pelo reverse do Photon. Só consulta em fuso do Brasil e com
 * `REGIONAL_HOLIDAYS` ligado. Se o Photon falhar, devolve null e o ETA usa o calendário nacional.
 */
export async function regionAt(p: LatLon, timeZone: string): Promise<HolidayRegion | null> {
  if (!config.regionalHolidays || holidayCalendarFor(timeZone) === noHolidays) return null;
  const cell = geohash(p.lat, p.lon, CELL_PRECISION);
  const hit = regionCache.get(cell);
  if (hit !== undefined) return hit;
  if (failedCells.get(cell)) return null;
  const [lon, lat] = geohashCenter(cell);
  try {
    const res = PhotonReverse.parse(
      await fetchJson<unknown>(`${config.photonUrl}/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&limit=1&lang=default`, {
        timeoutMs: 3000,
      }),
    );
    const region = toRegion(res.features[0]?.properties);
    regionCache.set(cell, region);
    return region;
  } catch {
    // Photon fora do ar ou resposta fora do formato: calendário nacional, sem quebrar o plano.
    failedCells.set(cell, true);
    return null;
  }
}
