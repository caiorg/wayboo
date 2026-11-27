import { describe, expect, it } from 'vitest';
import {
  corridorDownloads,
  judgeProgress,
  MAX_TILES_PER_DOWNLOAD,
  OFFLINE_MAX_ZOOM,
  OFFLINE_MIN_ZOOM,
  reusesTilesOf,
  STOP_AT_BYTES,
  tileCount,
  type Bounds,
} from '../src/lib/offlineArea';

type Coord = [number, number];

const inside = ([lon, lat]: Coord, [w, s, e, n]: Bounds) => lon >= w && lon <= e && lat >= s && lat <= n;

/** Reta com um ponto a cada `steps`-ésimo do caminho, como uma geometria de rota. */
const line = (from: Coord, to: Coord, steps: number): Coord[] =>
  Array.from({ length: steps + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);

describe('tileCount', () => {
  it('conta um tile no zoom 0 e quatro no zoom 1 para o mundo', () => {
    const world: Bounds = [-180, -85, 180, 85];
    expect(tileCount(world, 0, 0)).toBe(1);
    expect(tileCount(world, 0, 1)).toBe(5);
  });

  it('um ponto cai num tile por zoom', () => {
    expect(tileCount([-46.63, -23.55, -46.63, -23.55], 10, 14)).toBe(5);
  });

  it('conta colunas e linhas da caixa', () => {
    // Zoom 2: colunas de 90° de longitude e linhas cortadas em 66,5°, 0° e -66,5° de latitude.
    // [-100, -10] a [10, 70] cobre as colunas 0 a 2 e as linhas 0 a 2.
    expect(tileCount([-100, -10, 10, 70], 2, 2)).toBe(9);
  });
});

describe('corridorDownloads', () => {
  it('rota vazia não baixa nada', () => {
    expect(corridorDownloads([])).toEqual([]);
  });

  it('rota curta cabe num download só e cobre a rota com folga', () => {
    const route = line([-46.65, -23.56], [-46.6, -23.52], 20);
    const parts = corridorDownloads(route);
    expect(parts).toHaveLength(1);
    for (const p of route) expect(inside(p, parts[0]!)).toBe(true);
    // A folga cobre ruas paralelas: a caixa passa do primeiro ponto.
    expect(parts[0]![0]).toBeLessThan(-46.65);
  });

  it('rota longa vira várias partes, cada uma dentro do limite de tiles', () => {
    // São Paulo ao Rio em linha reta, com pontos esparsos como numa rodovia.
    const route = line([-46.63, -23.55], [-43.2, -22.9], 40);
    const parts = corridorDownloads(route);
    expect(parts.length).toBeGreaterThan(1);
    for (const b of parts) expect(tileCount(b, OFFLINE_MIN_ZOOM, OFFLINE_MAX_ZOOM)).toBeLessThanOrEqual(MAX_TILES_PER_DOWNLOAD);
    // Todo trecho da rota, inclusive entre pontos esparsos, fica dentro de alguma parte.
    for (const p of line([-46.63, -23.55], [-43.2, -22.9], 2000)) expect(parts.some((b) => inside(p, b))).toBe(true);
  });

  it('partes vizinhas se encostam, sem buraco no corredor', () => {
    const parts = corridorDownloads(line([-46.63, -23.55], [-43.2, -22.9], 40));
    for (let i = 1; i < parts.length; i++) {
      const [w1, s1, e1, n1] = parts[i - 1]!;
      const [w2, s2, e2, n2] = parts[i]!;
      expect(w2 <= e1 && w1 <= e2 && s2 <= n1 && s1 <= n2).toBe(true);
    }
  });

  it('respeita um limite menor', () => {
    const parts = corridorDownloads(line([-46.63, -23.55], [-46.0, -23.3], 30), { maxTiles: 200 });
    expect(parts.length).toBeGreaterThan(1);
    for (const b of parts) expect(tileCount(b, OFFLINE_MIN_ZOOM, OFFLINE_MAX_ZOOM)).toBeLessThanOrEqual(200);
  });
});

describe('judgeProgress', () => {
  const status = (patch: Partial<Parameters<typeof judgeProgress>[0]> = {}) => ({
    state: 'active' as const,
    completedResourceSize: 0,
    completedTileCount: 0,
    completedTileSize: 0,
    ...patch,
  });

  it('segue baixando dentro dos limites', () => {
    expect(judgeProgress(status({ completedResourceSize: 10_000_000, completedTileCount: 500 }))).toBe('downloading');
  });

  it('termina quando o pacote fica completo', () => {
    expect(judgeProgress(status({ state: 'complete', completedResourceSize: 10_000_000 }))).toBe('complete');
  });

  it('nos estilos que reaproveitam tiles, só o resto conta para os 50 MB', () => {
    const s = status({ completedResourceSize: STOP_AT_BYTES + 5_000_000, completedTileSize: STOP_AT_BYTES, completedTileCount: 900 });
    expect(judgeProgress(s)).toBe('limit');
    expect(judgeProgress(s, { reusesTiles: true })).toBe('downloading');
  });

  it('para antes de 50 MB ou de 3.000 tiles', () => {
    expect(judgeProgress(status({ completedResourceSize: STOP_AT_BYTES }))).toBe('limit');
    expect(judgeProgress(status({ completedTileCount: MAX_TILES_PER_DOWNLOAD }))).toBe('limit');
  });
});

describe('reusesTilesOf', () => {
  const style = (sources: Record<string, { url?: string; tiles?: string[] }>) => ({ version: 8, sources, layers: [] });
  const light = style({ omt: { url: 'https://t.example/planet' }, shade: { tiles: ['https://t.example/ne/{z}/{x}/{y}.png'] } });

  it('reaproveita quando as fontes do segundo estilo já estão no primeiro', () => {
    expect(reusesTilesOf(light, style({ base: { url: 'https://t.example/planet' } }))).toBe(true);
  });

  it('não reaproveita com uma fonte nova', () => {
    expect(reusesTilesOf(light, style({ omt: { url: 'https://outro.example/planet' } }))).toBe(false);
  });

  it('não reaproveita sem o style JSON ou sem fontes', () => {
    expect(reusesTilesOf(light, null)).toBe(false);
    expect(reusesTilesOf(null, light)).toBe(false);
    expect(reusesTilesOf(light, style({}))).toBe(false);
  });
});
