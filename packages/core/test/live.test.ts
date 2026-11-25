import { describe, expect, it } from 'vitest';
import {
  aggregateLive,
  LIVE_HALF_LIFE_MS,
  LIVE_WINDOW_MS,
  liveObservations,
  predictEta,
  type LiveObservation,
  type LiveTraffic,
  type Route,
  type TripContext,
} from '../src';

const TZ = 'America/Sao_Paulo';
const NO_CTX: TripContext = { rain: false, heavyRain: false, lowVisibility: false, alertsOnRoute: 0 };
/** Terça, 12:00 em São Paulo. */
const NOW = Date.UTC(2026, 10, 24, 15, 0);
const MIN = 60_000;

/** Rota só com trechos: `predictEta` não olha a geometria. */
function route(segBaseS: number[]): Route {
  let m = 0;
  const segments = segBaseS.map((baseDurationS, i) => {
    const s = { key: `seg${i}`, startM: m, endM: m + 300, baseDurationS };
    m += 300;
    return s;
  });
  const baseDurationS = segBaseS.reduce((a, b) => a + b, 0);
  return {
    id: 'r',
    geometry: [],
    distanceM: m,
    baseDurationS,
    maneuvers: [],
    hasToll: false,
    hasHighway: false,
    hasFerry: false,
    highwayShare: 0,
    segments,
    provider: 'test',
  };
}

const obs = (contributor: string, x: number, ageMs = 0, seg = 'seg0'): LiveObservation => ({ seg, contributor, t: NOW - ageMs, x });

describe('agregação ao vivo', () => {
  it('publica o trecho só com pelo menos 3 usuários distintos', () => {
    expect(aggregateLive([obs('a', 1), obs('b', 1)], NOW).has('seg0')).toBe(false);
    const live = aggregateLive([obs('a', 1), obs('b', 1), obs('c', 1)], NOW);
    expect(live.get('seg0')).toMatchObject({ users: 3, mean: 1 });
  });

  it('aceita outro mínimo de usuários', () => {
    expect(aggregateLive([obs('a', 1), obs('b', 1)], NOW, 2).get('seg0')?.users).toBe(2);
    expect(aggregateLive([obs('a', 1), obs('b', 1), obs('c', 1)], NOW, 4).size).toBe(0);
  });

  it('conta cada usuário uma vez, com a observação mais recente dele', () => {
    const live = aggregateLive([obs('a', 0, 2 * MIN), obs('a', 1), obs('a', 1, MIN), obs('b', 1), obs('c', 1)], NOW);
    expect(live.get('seg0')?.users).toBe(3);
    expect(live.get('seg0')?.mean).toBeCloseTo(1, 9);
    expect(aggregateLive([obs('a', 1), obs('a', 1, MIN), obs('b', 1)], NOW).size).toBe(0);
  });

  it('ignora observações fora da janela de 15 min', () => {
    expect(aggregateLive([obs('a', 1), obs('b', 1), obs('c', 1, LIVE_WINDOW_MS + 1)], NOW).size).toBe(0);
    expect(aggregateLive([obs('a', 1), obs('b', 1), obs('c', 1, LIVE_WINDOW_MS)], NOW).get('seg0')?.users).toBe(3);
    // Observação do futuro (relógio adiantado) também fica de fora.
    expect(aggregateLive([obs('a', 1), obs('b', 1), obs('c', 1, -MIN)], NOW).size).toBe(0);
  });

  it('pesa cada observação pela idade, com meia-vida de 5 min', () => {
    expect(LIVE_HALF_LIFE_MS).toBe(5 * MIN);
    const live = aggregateLive([obs('a', 1), obs('b', 0.5, 5 * MIN), obs('c', 0, 10 * MIN)], NOW).get('seg0')!;
    expect(live.w).toBeCloseTo(1.75, 9);
    expect(live.mean).toBeCloseTo((1 + 0.25) / 1.75, 9);
  });

  it('não conta quem consulta nem usa a medida dele', () => {
    expect(aggregateLive([obs('a', 2), obs('b', 1), obs('c', 1)], NOW, 3, 'a').size).toBe(0);
    const live = aggregateLive([obs('a', 2), obs('b', 1), obs('c', 1), obs('d', 1)], NOW, 3, 'a').get('seg0');
    expect(live).toMatchObject({ users: 3, mean: 1 });
  });

  it('separa os trechos', () => {
    const live = aggregateLive(
      [obs('a', 1), obs('b', 1), obs('c', 1), obs('a', 0.2, 0, 'seg1'), obs('b', 0.2, 0, 'seg1')],
      NOW,
    );
    expect([...live.keys()]).toEqual(['seg0']);
  });
});

describe('observações ao vivo de um rastro', () => {
  const r = route([60, 60, 1]);

  it('converte a saída do trecho para o relógio do servidor e grava o log da razão', () => {
    // Relógio do aparelho 1 h adiantado: só a distância até a última amostra importa.
    const last = NOW + 60 * MIN;
    const out = liveObservations(
      r,
      [
        { index: 0, enteredAt: last - 150_000, durationS: 120 },
        { index: 1, enteredAt: last - 30_000, durationS: 30 },
      ],
      last,
      NOW,
    );
    expect(out).toEqual([
      { seg: 'seg0', t: NOW - 30_000, x: Math.log(2) },
      { seg: 'seg1', t: NOW, x: Math.log(0.5) },
    ]);
  });

  it('descarta saídas fora da janela e trechos curtos demais', () => {
    const out = liveObservations(
      r,
      [
        { index: 0, enteredAt: NOW - LIVE_WINDOW_MS - 120_000, durationS: 60 },
        { index: 2, enteredAt: NOW - 2000, durationS: 1 },
      ],
      NOW,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('limita a razão como o aprendizado histórico', () => {
    const [o] = liveObservations(r, [{ index: 0, enteredAt: NOW - 3_600_000, durationS: 3600 }], NOW, NOW);
    expect(o?.x).toBe(2.5);
  });
});

describe('ETA com trânsito ao vivo', () => {
  const r = route(Array.from({ length: 10 }, () => 60));
  const slow = (factor: number, users = 3): LiveTraffic => ({
    at: NOW,
    segments: new Map(r.segments.map((s) => [s.key, { mean: Math.log(factor), w: users, users }])),
  });
  const base = (departAt = NOW, live?: LiveTraffic) =>
    predictEta({ route: r, departAt, timeZone: TZ, user: new Map(), crowd: new Map(), ctx: NO_CTX, live });

  it('reflete a lentidão observada agora nos trechos', () => {
    const plain = base();
    expect(plain.durationS).toBeCloseTo(600, 6);
    const e = base(NOW, slow(2));
    // 3 usuários recentes: o ao vivo leva 3/4 do caminho entre o histórico e o observado.
    expect(e.segmentDurationsS[0]).toBeCloseTo(60 * 2 ** 0.75, 6);
    // Os trechos seguintes são alcançados mais tarde e pesam um pouco menos o ao vivo.
    expect(e.durationS).toBeGreaterThan(plain.durationS * 1.5);
    expect(e.durationS).toBeLessThan(plain.durationS * 2 ** 0.75);
    const f = e.factors.find((x) => x.kind === 'live');
    expect(f?.deltaS).toBeCloseTo(e.durationS - plain.durationS, 6);
    expect(e.factors.some((x) => x.kind === 'segments')).toBe(false);
  });

  it('tem prioridade sobre o histórico do trecho', () => {
    const crowd = new Map(
      r.segments.map((s) => [`sb|${s.key}|weekday|24`, { w: 50, mean: Math.log(0.8), m2: 0, t: NOW }] as const),
    );
    const hist = predictEta({ route: r, departAt: NOW, timeZone: TZ, user: new Map(), crowd, ctx: NO_CTX });
    expect(hist.durationS).toBeLessThan(600 * 0.85);
    const live = predictEta({ route: r, departAt: NOW, timeZone: TZ, user: new Map(), crowd, ctx: NO_CTX, live: slow(2) });
    expect(live.durationS).toBeGreaterThan(hist.durationS * 1.6);
  });

  it('não conta duas vezes a chuva e os alertas que a medida ao vivo já inclui', () => {
    const ctx: TripContext = { rain: true, heavyRain: false, lowVisibility: false, alertsOnRoute: 0 };
    const run = (live?: LiveTraffic) =>
      predictEta({ route: r, departAt: NOW, timeZone: TZ, user: new Map(), crowd: new Map(), ctx, alertPenaltyS: 300, live });
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const plain = run();
    const e = run(slow(2));
    const penalty = (x: typeof e) => x.factors.find((f) => f.kind === 'alerts')!.deltaS;
    const ctxMult = (x: typeof e) => (x.durationS - penalty(x)) / sum(x.segmentDurationsS);
    expect(ctxMult(plain)).toBeCloseTo(1.08, 6);
    expect(ctxMult(e)).toBeGreaterThan(1);
    expect(ctxMult(e)).toBeLessThan(1.04);
    expect(penalty(plain)).toBe(300);
    expect(penalty(e)).toBeLessThan(150);
  });

  it('sem trecho publicado o ETA não muda', () => {
    expect(base(NOW, { at: NOW, segments: new Map() })).toEqual(base());
  });

  it('não vale para saídas daqui a 45 min ou mais', () => {
    expect(base(NOW + 45 * MIN, slow(2)).durationS).toBeCloseTo(base(NOW + 45 * MIN).durationS, 9);
    const in20 = base(NOW + 20 * MIN, slow(2)).durationS;
    expect(in20).toBeGreaterThan(base(NOW + 20 * MIN).durationS);
    expect(in20).toBeLessThan(base(NOW, slow(2)).durationS);
  });

  it('perde efeito nos trechos alcançados mais à frente na viagem', () => {
    const long = route([1200, 1200, 1200, 1200]);
    const live: LiveTraffic = {
      at: NOW,
      segments: new Map(long.segments.map((s) => [s.key, { mean: Math.log(2), w: 3, users: 3 }])),
    };
    const plain = predictEta({ route: long, departAt: NOW, timeZone: TZ, user: new Map(), crowd: new Map(), ctx: NO_CTX });
    const e = predictEta({ route: long, departAt: NOW, timeZone: TZ, user: new Map(), crowd: new Map(), ctx: NO_CTX, live });
    expect(e.segmentDurationsS[0]).toBeCloseTo(1200 * 2 ** 0.75, 6);
    // O trecho 1 começa 20 min × 2^0,75 depois da saída: efeito menor que no primeiro.
    expect(e.segmentDurationsS[1]!).toBeLessThan(e.segmentDurationsS[0]!);
    expect(e.segmentDurationsS[1]!).toBeGreaterThan(1200);
    expect(e.segmentDurationsS[3]).toBeCloseTo(plain.segmentDurationsS[3]!, 9);
  });
});
