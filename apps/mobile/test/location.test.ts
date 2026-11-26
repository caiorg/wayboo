import type { NavFix } from '@wayboo/core';
import type { LocationObject } from 'expo-location';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishLocations, resetPublishedLocations, useLocationStore } from '../src/lib/location';

vi.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  requestForegroundPermissionsAsync: vi.fn(),
  watchPositionAsync: vi.fn(),
}));

const loc = (timestamp: number, extra: Partial<LocationObject['coords']> = {}): LocationObject => ({
  timestamp,
  coords: { latitude: -23.5, longitude: -46.6, altitude: null, accuracy: 5, altitudeAccuracy: null, heading: 90, speed: 10, ...extra },
});

beforeEach(() => {
  resetPublishedLocations();
  useLocationStore.setState({ fix: null });
});

describe('publishLocations', () => {
  it('converte a leitura do GPS em fix, com velocidade e rumo negativos como null', () => {
    publishLocations([loc(1000, { speed: -1, heading: -1, accuracy: 8 })]);
    expect(useLocationStore.getState().fix).toEqual({ t: 1000, lat: -23.5, lon: -46.6, speed: null, heading: null, accuracy: 8 });
  });

  it('publica cada leitura do lote em ordem de horário', () => {
    const seen: number[] = [];
    const unsub = useLocationStore.subscribe((s) => {
      if (s.fix) seen.push(s.fix.t);
    });
    publishLocations([loc(3000), loc(1000), loc(2000)]);
    unsub();
    expect(seen).toEqual([1000, 2000, 3000]);
  });

  it('ignora leituras repetidas ou mais antigas, que chegam pelo watcher e pela task ao mesmo tempo', () => {
    const seen: number[] = [];
    const unsub = useLocationStore.subscribe((s) => {
      if (s.fix) seen.push(s.fix.t);
    });
    publishLocations([loc(1000), loc(2000)]);
    publishLocations([loc(2000)]);
    publishLocations([loc(1500), loc(3000)]);
    unsub();
    expect(seen).toEqual([1000, 2000, 3000]);
  });

  it('um fix da simulação, com horário adiantado, não bloqueia as leituras reais seguintes', () => {
    publishLocations([loc(1000)]);
    useLocationStore.setState({ fix: { t: 9_999_999, lat: 0, lon: 0 } as NavFix });
    publishLocations([loc(2000)]);
    expect(useLocationStore.getState().fix?.t).toBe(2000);
  });

  it('ignora um lote atrasado da task que repete leituras de mais de um minuto atrás', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(160_000);
    const seen: number[] = [];
    const unsub = useLocationStore.subscribe((st) => {
      if (st.fix) seen.push(st.fix.t);
    });
    publishLocations([loc(100_000)]);
    publishLocations([loc(160_000)]);
    now.mockReturnValue(170_000);
    publishLocations([loc(100_000), loc(160_000)]);
    unsub();
    now.mockRestore();
    expect(seen).toEqual([100_000, 160_000]);
  });

  it('volta a aceitar leituras quando o relógio do aparelho volta mais de um minuto', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    publishLocations([loc(10_000_000)]);
    now.mockReturnValue(1000);
    publishLocations([loc(1000)]);
    now.mockRestore();
    expect(useLocationStore.getState().fix?.t).toBe(1000);
  });

  it('depois da volta do relógio, um lote atrasado com pontos de antes dela não bloqueia as leituras atuais', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    const seen: number[] = [];
    const unsub = useLocationStore.subscribe((st) => {
      if (st.fix) seen.push(st.fix.t);
    });
    publishLocations([loc(9_999_000)]);
    publishLocations([loc(10_000_000)]);
    now.mockReturnValue(1000);
    publishLocations([loc(10_000_000), loc(1000)]);
    publishLocations([loc(9_999_000), loc(10_000_000)]);
    now.mockReturnValue(2000);
    publishLocations([loc(2000)]);
    unsub();
    now.mockRestore();
    expect(seen).toEqual([9_999_000, 10_000_000, 1000, 2000]);
  });

  it('depois da volta do relógio, aceita leituras com horário posterior ao da última publicada (horário do GPS no Android)', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    publishLocations([loc(10_000_000)]);
    now.mockReturnValue(1000);
    publishLocations([loc(10_001_000)]);
    now.mockRestore();
    expect(useLocationStore.getState().fix?.t).toBe(10_001_000);
  });

  it('lote vazio não muda nada', () => {
    publishLocations([]);
    expect(useLocationStore.getState().fix).toBeNull();
  });
});
