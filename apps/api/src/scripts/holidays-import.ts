/**
 * Gera `src/data/holidays-br.json` a partir de um clone de https://github.com/joaopbini/feriados-brasil (MIT).
 *
 *   git clone --depth 1 https://github.com/joaopbini/feriados-brasil.git /tmp/feriados-brasil
 *   bun src/scripts/holidays-import.ts /tmp/feriados-brasil
 *
 * O dataset tem um arquivo por ano. Para valer nos anos seguintes, cada feriado estadual ou municipal do
 * último ano vira regra (`ruleFor`): data fixa (`MM-DD`) ou distância da Páscoa (`E+N`), pela evidência dos
 * `HISTORY_YEARS` anos anteriores. Só o feriado que mudou de data fica com a data exata (`AAAA-MM-DD`) e vale
 * só naquele ano. Regras que o calendário nacional já cobre ficam de fora.
 * `CORRECTIONS` corrige, com a fonte oficial, os casos em que o dataset diverge da lei.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brazilNationalHolidays, easterSunday, type LocalDate } from '@wayboo/core';
import { z } from 'zod';
import type { HolidayData } from '../holidays';

/** Data `DD/MM/AAAA` que existe no calendário (rejeita 31/02 e texto solto). */
const DateBr = z
  .string()
  .regex(/^\d{2}\/\d{2}\/\d{4}$/)
  .transform((s): LocalDate => {
    const [day, month, year] = s.split('/').map(Number);
    return { year: year!, month: month!, day: day! };
  })
  .refine((d) => {
    const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
    return t.getUTCFullYear() === d.year && t.getUTCMonth() === d.month - 1 && t.getUTCDate() === d.day;
  }, 'data inexistente');
const Uf = z.string().regex(/^[A-Z]{2}$/);
const Ibge = z.number().int().min(1_000_000).max(9_999_999);
const Holidays = z.array(z.object({ data: DateBr, nome: z.string().trim().min(1), uf: Uf.nullable(), codigo_ibge: Ibge.nullable() }));
const States = z.array(z.object({ uf: Uf, nome: z.string().min(1), codigo_uf: z.number().int() })).length(27);
const Cities = z.array(z.object({ codigo_ibge: Ibge, nome: z.string().min(1), codigo_uf: z.number().int() }));

/** Regra `MM-DD`, `E+N`/`E-N` ou `AAAA-MM-DD`, como em `HolidayData.holidays`. */
type Rule = string;
const HISTORY_YEARS = 3;

/** Divergências do dataset conferidas em fonte oficial. `drop` remove regras geradas; `add` acrescenta. */
const CORRECTIONS: { scope: string; drop?: Rule[]; add?: [Rule, string][]; source: string }[] = [
  {
    scope: 'SC',
    drop: ['08-11'],
    source:
      'Lei estadual 18.531/2022 e Decreto 16/2023: o Dia do Estado (11/8) passa para o domingo seguinte, que o ETA já trata como domingo.',
  },
  {
    scope: 'ES',
    drop: ['04-28'],
    add: [['E+8', 'Nossa Senhora da Penha']],
    source:
      'Lei estadual 11.010/2019: Nossa Senhora da Penha é feriado na segunda-feira oito dias depois da Páscoa (13/4/2026, confirmado em es.gov.br). O 28/4/2026 do dataset repete a data de 2025.',
  },
  {
    scope: 'PA',
    drop: ['12-08'],
    source: 'Decreto estadual 5.122/2025: em 2026 o único feriado estadual é 15/8; 8/12 (Nossa Senhora da Conceição) é ponto facultativo.',
  },
  {
    scope: '1506807',
    add: [['12-08', 'Nossa Senhora da Conceição']],
    source: 'Santarém, Decreto municipal 498/2026: 8/12, dia da padroeira, é feriado municipal. O dataset só traz 22/6.',
  },
];

const repo = process.argv[2];
if (!repo) throw new Error('Uso: holidays-import.ts <clone de joaopbini/feriados-brasil>');
const dados = join(repo, 'dados');
function read<T extends z.ZodType>(schema: T, ...p: string[]): z.output<T> {
  const r = schema.safeParse(JSON.parse(readFileSync(join(dados, ...p), 'utf8')));
  if (!r.success) throw new Error(`${p.join('/')} fora do formato esperado: ${z.prettifyError(r.error)}`);
  return r.data;
}

const years = readdirSync(join(dados, 'feriados/estadual/json'))
  .map((f) => Number(f.replace('.json', '')))
  .filter(Number.isInteger)
  .sort((a, b) => a - b);
const last = years[years.length - 1]!;
/** Anos anteriores usados como evidência de recorrência. */
const history = years.filter((y) => y < last && y >= last - HISTORY_YEARS);
if (!history.length) throw new Error(`Faltam anos anteriores a ${last}`);

const pad = (n: number) => String(n).padStart(2, '0');
const md = (d: LocalDate) => `${pad(d.month)}-${pad(d.day)}`;
const utc = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
const easterOffset = (d: LocalDate) => Math.round((utc(d) - utc(easterSunday(d.year))) / 86_400_000);
const easterRule = (off: number) => `E${off >= 0 ? '+' : ''}${off}`;

/** Regras que o calendário nacional já cobre em todos os anos: datas fixas e distâncias da Páscoa. */
const nationalRules = new Set<Rule>();
{
  const perYear = [last, ...history].map((y) => brazilNationalHolidays(y));
  const all = (f: (d: LocalDate) => Rule) => perYear.map((list) => new Set(list.map((h) => f(h.date))));
  for (const [f] of [[md], [(d: LocalDate) => easterRule(easterOffset(d))]] as const) {
    const sets = all(f);
    for (const r of sets[0]!) if (sets.every((s) => s.has(r))) nationalRules.add(r);
  }
}
const isNational = (rule: Rule) =>
  nationalRules.has(rule) || (rule.length === 10 && brazilNationalHolidays(Number(rule.slice(0, 4))).some((h) => md(h.date) === rule.slice(5)));

type Occurrence = { date: LocalDate; name: string };
/** Feriados por escopo (UF ou código IBGE) num ano, inclusive os que coincidem com um nacional. */
function byScope(kind: 'estadual' | 'municipal', year: number) {
  const out = new Map<string, Occurrence[]>();
  for (const h of read(Holidays, 'feriados', kind, 'json', `${year}.json`)) {
    const scope = kind === 'estadual' ? h.uf : h.codigo_ibge === null ? null : String(h.codigo_ibge);
    if (!scope) continue;
    const list = out.get(scope) ?? [];
    list.push({ date: h.data, name: h.nome });
    out.set(scope, list);
  }
  return out;
}

/**
 * Celebrações móveis reconhecidas pelo nome. O dataset às vezes repete num ano a data do ano anterior
 * (Cinzas em 5/3/2026, que foi 18/2) ou grafa o nome errado ("Cospus Christi"); o nome vale mais que a data.
 */
const EASTER_BY_NAME: [RegExp, number][] = [
  [/cinzas/, -46],
  [/christi/, 60],
  [/sexta.feira santa|paixao/, -2],
];
const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/**
 * Regra de um feriado do último ano (`h`), dados os anos anteriores (`previous`) e o último ano (`current`)
 * do mesmo escopo. A ordem importa:
 * 1. celebração móvel pelo nome (`EASTER_BY_NAME`): segue a Páscoa;
 * 2. mesmo nome na mesma data em todos os anos anteriores em que aparece: `MM-DD`;
 * 3. data que, no último ano, é um feriado móvel nacional (Carnaval, Sexta-feira Santa, Corpus Christi):
 *    a regra nacional, que depois sai do catálogo, e não uma data fixa;
 * 4. mesma distância da Páscoa em todos os anos anteriores: `E+N`;
 * 5. nome novo, ou nenhuma data anterior com esse nome sumiu no último ano (feriado acrescentado): `MM-DD`;
 * 6. resto (uma data anterior sumiu, então o feriado mudou de data): data exata, só naquele ano.
 * O passo 5 cobre nomes genéricos como "Feriado Municipal", que o nome não distingue: um feriado genérico
 * novo e outro transferido no mesmo ano ficam indistinguíveis, e os dois viram data exata.
 */
function ruleFor(h: Occurrence, previous: Occurrence[][], current: Occurrence[]): Rule {
  const byName = EASTER_BY_NAME.find(([re]) => re.test(plain(h.name)));
  if (byName) return easterRule(byName[1]);
  const key = h.name.toLowerCase();
  const sameName = (list: Occurrence[]) => list.filter((o) => o.name.toLowerCase() === key);
  const seen = previous.map(sameName).filter((l) => l.length);
  if (seen.length && seen.every((l) => l.some((o) => md(o.date) === md(h.date)))) return md(h.date);
  const off = easterOffset(h.date);
  if (nationalRules.has(easterRule(off))) return easterRule(off);
  if (seen.length && seen.every((l) => l.some((o) => easterOffset(o.date) === off))) return easterRule(off);
  const now = sameName(current).map((o) => md(o.date));
  const latest = seen[seen.length - 1] ?? [];
  if (latest.every((o) => now.includes(md(o.date)))) return md(h.date);
  return `${h.date.year}-${md(h.date)}`;
}

const holidays: HolidayData['holidays'] = {};
for (const kind of ['estadual', 'municipal'] as const) {
  const before = history.map((y) => byScope(kind, y));
  for (const [scope, list] of byScope(kind, last)) {
    const previous = before.map((m) => m.get(scope) ?? []);
    const rules = new Map<Rule, string>();
    for (const h of list) {
      const rule = ruleFor(h, previous, list);
      if (!isNational(rule) && !rules.has(rule)) rules.set(rule, h.name);
    }
    if (rules.size) holidays[scope] = [...rules].sort(([a], [b]) => a.localeCompare(b));
  }
}

for (const c of CORRECTIONS) {
  const current = holidays[c.scope] ?? [];
  for (const rule of c.drop ?? []) {
    if (!current.some(([r]) => r === rule)) throw new Error(`Correção de ${c.scope}: a regra ${rule} não existe mais no dataset. Revise.`);
  }
  const kept = current.filter(([r]) => !c.drop?.includes(r));
  holidays[c.scope] = [...kept, ...(c.add ?? [])].sort(([a], [b]) => a.localeCompare(b));
}

const states = read(States, 'localizacao', 'estados', 'estados.json');
const ufByCode = new Map(states.map((s) => [s.codigo_uf, s.uf]));
const municipalities: HolidayData['municipalities'] = {};
for (const m of read(Cities, 'localizacao', 'municipios', 'municipios.json')) {
  if (!holidays[String(m.codigo_ibge)]) continue;
  const uf = ufByCode.get(m.codigo_uf);
  if (!uf) continue;
  (municipalities[uf] ??= {})[m.nome] = m.codigo_ibge;
}

const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const data: HolidayData = {
  source: { repo: 'https://github.com/joaopbini/feriados-brasil', commit, license: 'MIT', years: [history[0]!, last] },
  states: Object.fromEntries(states.map((s) => [s.uf, s.nome]).sort(([a], [b]) => a!.localeCompare(b!))),
  municipalities,
  holidays,
};
writeFileSync(new URL('../data/holidays-br.json', import.meta.url), `${JSON.stringify(data)}\n`);
const scopes = Object.keys(holidays);
const rules = Object.values(holidays).flat();
console.log(
  `${scopes.length} escopos, ${rules.length} feriados (${rules.filter(([r]) => r.length > 7).length} com data exata), fonte ${commit.slice(0, 7)}`,
);
