/** Coordenada no formato GeoJSON: [lon, lat]. */
export type Coord = [number, number];

const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(a: Coord, b: Coord): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a: Coord, b: Coord): number {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x =
    Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
    Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Decodifica polyline (Valhalla usa precisão 6, OSRM usa 5). */
export function decodePolyline(str: string, precision = 6): Coord[] {
  const factor = 10 ** precision;
  const out: Coord[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/** Codifica polyline, o inverso de `decodePolyline`. */
export function encodePolyline(coords: Coord[], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * factor);
    const lo = Math.round(lon * factor);
    enc(la - prevLat);
    enc(lo - prevLon);
    prevLat = la;
    prevLon = lo;
  }
  return out;
}

export function cumulativeDistances(coords: Coord[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1]! + haversine(coords[i - 1]!, coords[i]!));
  return cum;
}

export interface Projection {
  /** Índice do vértice inicial do trecho projetado. */
  index: number;
  point: Coord;
  /** Distância perpendicular do ponto até a linha, em metros. */
  offsetM: number;
  /** Distância percorrida ao longo da linha até a projeção, em metros. */
  alongM: number;
}

/**
 * Projeta `p` na polyline. A busca fica restrita a [fromIdx, toIdx] para que o
 * rastreamento em tempo real seja O(janela) e não O(rota).
 */
export function projectOnPolyline(
  coords: Coord[],
  cum: number[],
  p: Coord,
  fromIdx = 0,
  toIdx = coords.length - 1,
): Projection {
  const kx = Math.cos(p[1] * RAD) * R * RAD;
  const ky = R * RAD;
  let best: Projection = { index: 0, point: coords[0]!, offsetM: Infinity, alongM: 0 };
  const start = Math.max(0, fromIdx);
  const end = Math.min(coords.length - 1, toIdx);
  for (let i = start; i < end; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const ax = (a[0] - p[0]) * kx;
    const ay = (a[1] - p[1]) * ky;
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < best.offsetM) {
      best = {
        index: i,
        point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
        offsetM: d,
        alongM: cum[i]! + t * (cum[i + 1]! - cum[i]!),
      };
    }
  }
  if (coords.length === 1) best = { index: 0, point: coords[0]!, offsetM: haversine(coords[0]!, p), alongM: 0 };
  return best;
}

export function pointAlong(coords: Coord[], cum: number[], alongM: number): Coord {
  if (alongM <= 0) return coords[0]!;
  const total = cum[cum.length - 1]!;
  if (alongM >= total) return coords[coords.length - 1]!;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= alongM) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi]! - cum[lo]!;
  const t = seg === 0 ? 0 : (alongM - cum[lo]!) / seg;
  const a = coords[lo]!;
  const b = coords[hi]!;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Distância mínima de um ponto até a polyline (sem janela). */
export function distanceToPolyline(coords: Coord[], cum: number[], p: Coord): Projection {
  return projectOnPolyline(coords, cum, p);
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Geohash: precisão 7 ≈ 153 m x 153 m; 6 ≈ 1,2 km x 0,6 km. */
export function geohash(lat: number, lon: number, precision = 7): string {
  let latR: [number, number] = [-90, 90];
  let lonR: [number, number] = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) {
      ch = (ch << 1) | 1;
      r[0] = mid;
    } else {
      ch <<= 1;
      r[1] = mid;
    }
    if (even) lonR = r;
    else latR = r;
    even = !even;
    if (++bit === 5) {
      hash += B32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function geohashCenter(hash: string): Coord {
  const latR = [-90, 90];
  const lonR = [-180, 180];
  let even = true;
  for (const c of hash) {
    const v = B32.indexOf(c);
    for (let m = 16; m >= 1; m >>= 1) {
      const r = even ? lonR : latR;
      const mid = (r[0]! + r[1]!) / 2;
      if (v & m) r[0] = mid;
      else r[1] = mid;
      even = !even;
    }
  }
  return [(lonR[0]! + lonR[1]!) / 2, (latR[0]! + latR[1]!) / 2];
}
