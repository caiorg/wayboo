import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { geohash, geohashCenter, localTime } from '@wayboo/core';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { db } from '../src/db';
import { clearHolidayRegionCache, regionAt, regionalCalendar } from '../src/holidays';
import { client, makeRoute, TZ } from './helpers';

const ROUTE = makeRoute();
vi.mock('../src/providers/routing', () => ({ valhalla: { name: 'test', route: async () => [structuredClone(ROUTE)] } }));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
}));

const SAO_PAULO = 3550308;
const july9 = { year: 2027, month: 7, day: 9 };

describe('calendário regional', () => {
  it('9 de julho é feriado em São Paulo e dia útil no Rio', () => {
    expect(regionalCalendar(TZ, { uf: 'SP', ibge: null })(july9)).toBe('Revolução Constitucionalista');
    expect(regionalCalendar(TZ, { uf: 'RJ', ibge: null })(july9)).toBeNull();
    expect(regionalCalendar(TZ, null)(july9)).toBeNull();
  });

  it('soma o municipal ao estadual e ao nacional, e só no município', () => {
    const jan25 = { year: 2027, month: 1, day: 25 };
    expect(regionalCalendar(TZ, { uf: 'SP', ibge: SAO_PAULO })(jan25)).toBe('Aniversário da Cidade');
    expect(regionalCalendar(TZ, { uf: 'SP', ibge: null })(jan25)).toBeNull();
    expect(regionalCalendar(TZ, { uf: 'SP', ibge: SAO_PAULO })(july9)).toBe('Revolução Constitucionalista');
    expect(regionalCalendar(TZ, { uf: 'SP', ibge: SAO_PAULO })({ year: 2027, month: 11, day: 2 })).toBe('Finados');
  });

  it('aplica as correções conferidas em fonte oficial (SC, ES e PA)', () => {
    // Lei SC 18.531/2022: o Dia do Estado (11/8) passa para o domingo seguinte.
    expect(regionalCalendar(TZ, { uf: 'SC', ibge: null })({ year: 2026, month: 8, day: 11 })).toBeNull();
    // Lei ES 11.010/2019: Nossa Senhora da Penha na segunda-feira oito dias depois da Páscoa. Aracruz não tem regra própria.
    const aracruz = regionalCalendar(TZ, { uf: 'ES', ibge: 3200607 });
    expect(aracruz({ year: 2026, month: 4, day: 13 })).toBe('Nossa Senhora da Penha');
    expect(aracruz({ year: 2027, month: 4, day: 5 })).toBe('Nossa Senhora da Penha');
    expect(aracruz({ year: 2026, month: 4, day: 28 })).toBeNull();
    // PA, Decreto 5.122/2025: 8/12 é ponto facultativo estadual. Santarém (Decreto 498/2026) tem o feriado municipal.
    const dec8 = { year: 2026, month: 12, day: 8 };
    expect(regionalCalendar(TZ, { uf: 'PA', ibge: 1504208 })(dec8)).toBeNull();
    expect(regionalCalendar(TZ, { uf: 'PA', ibge: 1506807 })(dec8)).toBe('Nossa Senhora da Conceição');
    expect(regionalCalendar(TZ, { uf: 'PA', ibge: null })({ year: 2026, month: 8, day: 15 })).toBe('Adesão ao Império Brasileiro');
  });

  it('feriado fixo continua valendo depois do último ano do dataset', () => {
    // Ribeirão Preto: 19/6 em todos os anos (em 2025 coincidiu com Corpus Christi).
    expect(regionalCalendar(TZ, { uf: 'SP', ibge: 3543402 })({ year: 2027, month: 6, day: 19 })).toBe(
      'Aniversário da Cidade e Dia de Santa Juliana Falconieri',
    );
    // Várzea Grande: 8/12 só aparece no último ano do dataset, sem sinal de data móvel.
    expect(regionalCalendar(TZ, { uf: 'MT', ibge: 5108402 })({ year: 2027, month: 12, day: 8 })).toBe('Nossa Senhora da Conceição');
    // Acre: o Dia do Católico muda de data entre os anos e só vale no ano do dataset.
    const ac = regionalCalendar(TZ, { uf: 'AC', ibge: null });
    expect(ac({ year: 2026, month: 1, day: 22 })).toBe('Dia do Católico');
    expect(ac({ year: 2027, month: 1, day: 22 })).toBeNull();
  });

  it('feriado móvel pelo nome segue a Páscoa, mesmo com a data errada no dataset', () => {
    // O dataset repete em 2026 a data de 2025: Cinzas em 5/3 (foi 18/2) e "Cospus Christi" em 19/6 (foi 4/6).
    const ibotirama = regionalCalendar(TZ, { uf: 'BA', ibge: 2913200 });
    expect(ibotirama({ year: 2026, month: 3, day: 5 })).toBeNull();
    expect(ibotirama({ year: 2026, month: 2, day: 18 })).toBe('Quarta-Feira de Cinzas');
    expect(ibotirama({ year: 2027, month: 2, day: 10 })).toBe('Quarta-Feira de Cinzas');
    const embuGuacu = regionalCalendar(TZ, { uf: 'SP', ibge: 3515103 });
    expect(embuGuacu({ year: 2026, month: 6, day: 19 })).toBeNull();
    expect(embuGuacu({ year: 2026, month: 6, day: 4 })).toBe('Corpus Christi');
  });

  it('feriado com nome novo na data de um móvel nacional segue a Páscoa, não vira data fixa', () => {
    // Rio: "Terça-feira de Carnaval" só aparece em 2026, em 17/2. Em 2027 o Carnaval é 9/2.
    const rio = regionalCalendar(TZ, { uf: 'RJ', ibge: 3304557 });
    expect(rio({ year: 2027, month: 2, day: 17 })).toBeNull();
    expect(rio({ year: 2027, month: 2, day: 9 })).toBe('Carnaval');
    expect(rio({ year: 2027, month: 6, day: 4 })).toBeNull();
  });

  it('"Feriado Municipal" genérico só vira data exata se uma data anterior sumiu', () => {
    // Acrelândia: 6/9 falta em 2024, mas 28/4 e 6/9 de 2025 continuam em 2026. Nada mudou de data, então são anuais.
    const acrelandia = regionalCalendar(TZ, { uf: 'AC', ibge: 1200013 });
    expect(acrelandia({ year: 2027, month: 9, day: 6 })).toBe('Feriado Municipal');
    expect(acrelandia({ year: 2027, month: 4, day: 28 })).toBe('Feriado Municipal');
  });

  it('fora dos fusos do Brasil, a região não acrescenta feriados', () => {
    expect(regionalCalendar('America/New_York', { uf: 'SP', ibge: SAO_PAULO })(july9)).toBeNull();
  });
});

const photon = (properties: object) =>
  new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-46.63, -23.55] }, properties }] }), {
    headers: { 'content-type': 'application/json' },
  });
let reverse: () => Response;
const photonCalls = vi.fn();

beforeEach(() => {
  config.regionalHolidays = true;
  clearHolidayRegionCache();
  photonCalls.mockClear();
  reverse = () => photon({ countrycode: 'BR', state: 'São Paulo', city: 'São Paulo' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${config.photonUrl}/reverse`)) {
        photonCalls(url);
        return reverse();
      }
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
});
afterEach(() => {
  config.regionalHolidays = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('região da viagem pelo Photon', () => {
  const here = { lat: -23.5614, lon: -46.6559 };

  it('acha estado e município pelo nome, sem diferenciar acento e maiúscula', async () => {
    expect(await regionAt(here, TZ)).toEqual({ uf: 'SP', ibge: SAO_PAULO });
    reverse = () => photon({ countrycode: 'BR', state: 'sao paulo', city: 'SAO PAULO' });
    clearHolidayRegionCache();
    expect(await regionAt(here, TZ)).toEqual({ uf: 'SP', ibge: SAO_PAULO });
  });

  it('município sem feriado próprio fica só com o estado; fora do Brasil não há região', async () => {
    reverse = () => photon({ countrycode: 'BR', state: 'Rio de Janeiro', city: 'Lugar Que Não Existe' });
    expect(await regionAt(here, TZ)).toEqual({ uf: 'RJ', ibge: null });
    clearHolidayRegionCache();
    reverse = () => photon({ countrycode: 'PY', state: 'Alto Paraná', city: 'Ciudad del Este' });
    expect(await regionAt(here, TZ)).toBeNull();
  });

  it('consulta uma vez por célula e manda só o centro da célula', async () => {
    const [lon, lat] = geohashCenter(geohash(here.lat, here.lon, 6));
    await regionAt(here, TZ);
    await regionAt({ lat, lon }, TZ);
    expect(photonCalls).toHaveBeenCalledTimes(1);
    const url = new URL(photonCalls.mock.calls[0]![0] as string);
    expect(url.searchParams.get('lat')).toBe(lat.toFixed(6));
    expect(url.searchParams.get('lon')).toBe(lon.toFixed(6));
  });

  it('com o Photon fora do ar, cai no calendário nacional sem erro', async () => {
    reverse = () => new Response('falhou', { status: 503 });
    expect(await regionAt(here, TZ)).toBeNull();
  });

  it('resposta do Photon fora do formato vira null, sem erro', async () => {
    reverse = () => new Response(JSON.stringify({ features: [{ properties: { countrycode: 7, state: ['SP'] } }] }));
    expect(await regionAt(here, TZ)).toBeNull();
    clearHolidayRegionCache();
    reverse = () => new Response(JSON.stringify({ type: 'FeatureCollection' }));
    expect(await regionAt(here, TZ)).toBeNull();
  });

  it('não consulta fora dos fusos do Brasil nem com REGIONAL_HOLIDAYS=off', async () => {
    expect(await regionAt(here, 'America/New_York')).toBeNull();
    config.regionalHolidays = false;
    expect(await regionAt(here, TZ)).toBeNull();
    expect(photonCalls).not.toHaveBeenCalled();
  });
});

describe('viagem no feriado estadual', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(() => app.close());
  const api = client(() => app, ROUTE);

  const dayTypes = (userId: string) =>
    new Set(
      (db.prepare("SELECT key FROM stats WHERE user_id = ? AND key LIKE 'sb|%'").all(userId) as { key: string }[]).map(
        (r) => r.key.split('|')[2],
      ),
    );

  it('em 9/7, viagem em SP aprende como feriado (domingo) e no RJ como dia útil', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Sexta-feira, 9/7/2027, 8h em Brasília.
    vi.setSystemTime(Date.UTC(2027, 6, 9, 11, 0));
    expect(localTime(Date.now(), TZ).dayType).toBe('weekday');

    const inSp = await api.register();
    const sp = await api.drive(inSp);
    expect(sp.finished!.learnedSegments).toBeGreaterThan(0);
    expect(dayTypes(inSp.userId)).toEqual(new Set(['sunday']));

    clearHolidayRegionCache();
    reverse = () => photon({ countrycode: 'BR', state: 'Rio de Janeiro', city: 'Rio de Janeiro' });
    const inRj = await api.register();
    await api.drive(inRj);
    expect(dayTypes(inRj.userId)).toEqual(new Set(['weekday']));
  });

  it('o plano guarda a região usada no ETA', async () => {
    const user = await api.register();
    const plan = await api.plan(user);
    expect(plan.holidayRegion).toEqual({ uf: 'SP', ibge: SAO_PAULO });
  });
});
