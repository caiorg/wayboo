/** Data civil no fuso local. `month` vai de 1 a 12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface Holiday {
  date: LocalDate;
  name: string;
}

/**
 * Diz se a data local é feriado e devolve o nome, ou null.
 * Para feriados estaduais e municipais, passe um calendário próprio para `localTime`,
 * `predictEta` e `learnFromTrip` (a API monta o da região em `apps/api/src/holidays.ts`).
 */
export type HolidayCalendar = (date: LocalDate) => string | null;

/** Estado (sigla) e município (código IBGE, ou null se não identificado) onde a viagem começa. */
export interface HolidayRegion {
  uf: string;
  ibge: number | null;
}

/** Domingo de Páscoa no calendário gregoriano (algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): LocalDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const dateKey = (d: LocalDate) => d.year * 10_000 + d.month * 100 + d.day;

/**
 * Feriados nacionais do Brasil (Leis 662/1949, 6.802/1980, 10.607/2002 e 14.759/2023),
 * mais as datas móveis que param o trânsito no país: Carnaval (segunda e terça),
 * Sexta-feira Santa e Corpus Christi. Ordenados por data.
 */
export function brazilNationalHolidays(year: number): Holiday[] {
  const fixed = (month: number, day: number, name: string): Holiday => ({ date: { year, month, day }, name });
  const easter = easterSunday(year);
  const moving = (offset: number, name: string): Holiday => ({ date: addDays(easter, offset), name });
  const list: Holiday[] = [
    fixed(1, 1, 'Confraternização Universal'),
    moving(-48, 'Carnaval'),
    moving(-47, 'Carnaval'),
    moving(-2, 'Sexta-feira Santa'),
    fixed(4, 21, 'Tiradentes'),
    fixed(5, 1, 'Dia do Trabalho'),
    moving(60, 'Corpus Christi'),
    fixed(9, 7, 'Independência do Brasil'),
    fixed(10, 12, 'Nossa Senhora Aparecida'),
    fixed(11, 2, 'Finados'),
    fixed(11, 15, 'Proclamação da República'),
    fixed(12, 25, 'Natal'),
  ];
  if (year >= 2024) list.push(fixed(11, 20, 'Dia Nacional de Zumbi e da Consciência Negra'));
  return list.sort((x, y) => dateKey(x.date) - dateKey(y.date));
}

const byYear = new Map<number, Map<number, string>>();

export const brazilNationalCalendar: HolidayCalendar = (date) => {
  let map = byYear.get(date.year);
  if (!map) {
    map = new Map(brazilNationalHolidays(date.year).map((h) => [dateKey(h.date), h.name]));
    byYear.set(date.year, map);
  }
  return map.get(dateKey(date)) ?? null;
};

export const noHolidays: HolidayCalendar = () => null;

// Em minúsculas: Intl aceita o identificador do fuso sem diferenciar maiúsculas.
const BRAZIL_TIME_ZONES = new Set(
  [
    'America/Araguaina',
    'America/Bahia',
    'America/Belem',
    'America/Boa_Vista',
    'America/Campo_Grande',
    'America/Cuiaba',
    'America/Eirunepe',
    'America/Fortaleza',
    'America/Maceio',
    'America/Manaus',
    'America/Noronha',
    'America/Porto_Acre',
    'America/Porto_Velho',
    'America/Recife',
    'America/Rio_Branco',
    'America/Santarem',
    'America/Sao_Paulo',
    'Brazil/Acre',
    'Brazil/DeNoronha',
    'Brazil/East',
    'Brazil/West',
  ].map((tz) => tz.toLowerCase()),
);

/** Calendário padrão pelo fuso: nacional brasileiro nos fusos do Brasil, nenhum nos demais. */
export function holidayCalendarFor(timeZone: string): HolidayCalendar {
  return BRAZIL_TIME_ZONES.has(timeZone.toLowerCase()) ? brazilNationalCalendar : noHolidays;
}
