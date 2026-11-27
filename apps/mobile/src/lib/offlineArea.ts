import type { Coord } from '@wayboo/core';

/** `[oeste, sul, leste, norte]`, o formato de `bounds` do `OfflineManager.createPack`. */
export type Bounds = [number, number, number, number];

/**
 * Zoom baixado. O vetor do OpenFreeMap vai até o 14, e o mapa amplia esses tiles no zoom da navegação (16,5).
 * Abaixo do 10 o corredor ocupa poucos pixels e não vale tiles.
 */
export const OFFLINE_MIN_ZOOM = 10;
export const OFFLINE_MAX_ZOOM = 14;

/** Limites por download dos termos do OpenFreeMap (https://openfreemap.org/tos/). */
export const MAX_TILES_PER_DOWNLOAD = 3000;
export const MAX_BYTES_PER_DOWNLOAD = 50_000_000;
/** Para antes dos 50 MB: as requisições já em andamento (até 4) ainda chegam depois da pausa. */
export const STOP_AT_BYTES = 46_000_000;

/**
 * Tiles por parte do corredor, abaixo do teto de 3.000: em área urbana densa os tiles do zoom 14 passam de 100 KB e
 * 3.000 deles estourariam os 50 MB. Caixas menores também seguem melhor uma rota diagonal.
 */
export const TILES_PER_PART = 1000;

/** Folga para cada lado da rota: cobre ruas paralelas e um desvio curto. */
const CORRIDOR_PAD_M = 1500;
/** Distância máxima entre pontos ao percorrer a rota. Trechos retos de rodovia têm pontos a quilômetros. */
const STEP_M = 1000;
const M_PER_DEG_LAT = 111_320;
const MAX_LAT = 85.0511;

const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

function tileX(lon: number, z: number): number {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

function tileY(lat: number, z: number): number {
  const n = 2 ** z;
  const rad = (clampLat(lat) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return Math.min(n - 1, Math.max(0, y));
}

/** Tiles que o download de `bounds` pede, somados de `minZoom` a `maxZoom`. */
export function tileCount([w, s, e, n]: Bounds, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    total += (tileX(e, z) - tileX(w, z) + 1) * (tileY(s, z) - tileY(n, z) + 1);
  }
  return total;
}

function pad([w, s, e, n]: Bounds, m: number): Bounds {
  const dLat = m / M_PER_DEG_LAT;
  const midLat = (s + n) / 2;
  const dLon = m / (M_PER_DEG_LAT * Math.max(0.01, Math.cos((midLat * Math.PI) / 180)));
  return [Math.max(-180, w - dLon), clampLat(s - dLat), Math.min(180, e + dLon), clampLat(n + dLat)];
}

const extend = ([w, s, e, n]: Bounds, [lon, lat]: Coord): Bounds => [Math.min(w, lon), Math.min(s, lat), Math.max(e, lon), Math.max(n, lat)];

const approxM = (a: Coord, b: Coord) => {
  const dLat = (b[1] - a[1]) * M_PER_DEG_LAT;
  const dLon = (b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

/** Pontos da rota com no máximo STEP_M entre vizinhos. */
function densify(geometry: Coord[]): Coord[] {
  const out: Coord[] = [];
  for (let i = 0; i < geometry.length; i++) {
    const b = geometry[i]!;
    const a = geometry[i - 1];
    if (a) {
      const steps = Math.ceil(approxM(a, b) / STEP_M);
      for (let k = 1; k < steps; k++) out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
    }
    out.push(b);
  }
  return out;
}

/**
 * Caixas que cobrem a rota com folga, cada uma com no máximo `maxTiles` tiles (nunca mais que MAX_TILES_PER_DOWNLOAD). O `OfflineManager` só baixa
 * retângulos, e uma caixa única de uma rota diagonal longa pegaria uma região enorme fora do caminho.
 * Caixas vizinhas compartilham um ponto da rota, então o corredor não tem buraco.
 */
export function corridorDownloads(geometry: Coord[], { maxTiles = TILES_PER_PART, padM = CORRIDOR_PAD_M } = {}): Bounds[] {
  maxTiles = Math.min(maxTiles, MAX_TILES_PER_DOWNLOAD);
  const points = densify(geometry);
  const first = points[0];
  if (!first) return [];
  const fits = (b: Bounds) => tileCount(pad(b, padM), OFFLINE_MIN_ZOOM, OFFLINE_MAX_ZOOM) <= maxTiles;
  const parts: Bounds[] = [];
  let box: Bounds = [first[0], first[1], first[0], first[1]];
  let prev = first;
  for (const p of points.slice(1)) {
    const grown = extend(box, p);
    if (fits(grown)) {
      box = grown;
    } else {
      parts.push(pad(box, padM));
      box = extend([prev[0], prev[1], prev[0], prev[1]], p);
    }
    prev = p;
  }
  parts.push(pad(box, padM));
  return parts;
}

export type DownloadVerdict = 'downloading' | 'complete' | 'limit';

export interface PackProgress {
  state: 'inactive' | 'active' | 'complete';
  completedResourceSize: number;
  completedTileCount: number;
  completedTileSize: number;
}

/** URLs de tiles de um style JSON: `url` do TileJSON ou a lista `tiles` de cada fonte. */
function tileSources(style: unknown): Set<string> {
  const urls = new Set<string>();
  const sources = (style as { sources?: unknown } | null)?.sources;
  if (!sources || typeof sources !== 'object') return urls;
  for (const source of Object.values(sources as Record<string, { url?: unknown; tiles?: unknown }>)) {
    if (typeof source?.url === 'string') urls.add(source.url);
    if (Array.isArray(source?.tiles)) for (const t of source.tiles) if (typeof t === 'string') urls.add(t);
  }
  return urls;
}

/**
 * Se o estilo `next` só usa fontes de tiles que `first` já baixou. Sem isso, os tiles do `next` são novos e contam
 * inteiros para os 50 MB. Um servidor próprio pode anunciar estilos claro e escuro com fontes diferentes.
 */
export function reusesTilesOf(first: unknown, next: unknown): boolean {
  const have = tileSources(first);
  const need = tileSources(next);
  return need.size > 0 && [...need].every((u) => have.has(u));
}

/**
 * Bytes que contam para o limite de 50 MB. O MapLibre soma em `completedResourceSize` também o que já estava no
 * banco. Num estilo que reaproveita as fontes do primeiro (`reusesTilesOf`), os tiles vêm do banco, então só estilo,
 * sprites e fontes contam.
 */
export const countedBytes = (s: PackProgress, reusesTiles: boolean) =>
  reusesTiles ? s.completedResourceSize - s.completedTileSize : s.completedResourceSize;

/**
 * O que fazer com um pacote a cada evento de progresso. `alreadyBytes` são os bytes dos pacotes anteriores do mesmo
 * download (os outros estilos da parte): todos dividem os mesmos 50 MB.
 */
export function judgeProgress(status: PackProgress, { reusesTiles = false, alreadyBytes = 0 } = {}): DownloadVerdict {
  if (status.state === 'complete') return 'complete';
  if (alreadyBytes + countedBytes(status, reusesTiles) >= STOP_AT_BYTES || status.completedTileCount >= MAX_TILES_PER_DOWNLOAD) return 'limit';
  return 'downloading';
}
