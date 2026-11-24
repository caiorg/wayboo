import type { Coord, LatLon, RoadAlert, SlowSpot } from '@wayboo/core';
import type { FeatureCollection } from 'geojson';
import { ALERT_SEVERITY, groupAlerts, severityRank } from '@/lib/alertGroups';
import { metersToPixelsAtZoom22 } from '@/lib/gpsAccuracy';
import { ALERT_COLORS, ALERT_ICONS, type Theme } from '@/lib/theme';

export interface MapRoute {
  id: string;
  coords: Coord[];
  selected: boolean;
}

export interface MapData {
  routes: MapRoute[];
  alerts: RoadAlert[];
  slowSpots: SlowSpot[];
  destination: LatLon | null;
  stops: LatLon[];
  /** `accuracy`: raio de incerteza do GPS em metros, desenhado em volta da bolinha. */
  puck: { lat: number; lon: number; heading: number | null; accuracy?: number | null } | null;
}

export type CameraCommand =
  | { type: 'fit'; bounds: [number, number, number, number]; padding: { top: number; bottom: number; left: number; right: number } }
  | { type: 'follow'; center: Coord; bearing: number; zoom: number; pitch: number }
  | { type: 'center'; center: Coord; zoom: number };

export interface MapViewProps {
  theme: Theme;
  data: MapData;
  /** `nonce` muda a cada comando, para repetir o mesmo enquadramento quando preciso. */
  camera: (CameraCommand & { nonce: number }) | null;
  initialCenter: Coord;
  onLongPress?: (p: LatLon) => void;
  onUserPan?: () => void;
  /** Toque num marcador de alerta. `id` é o alerta mostrado no marcador; o grupo sai de `groupIdsOf`. */
  onAlertPress?: (id: string) => void;
}

export const SOURCE = { routes: 'routes', alerts: 'alerts', spots: 'spots', points: 'points' } as const;

/** Camadas que respondem ao toque num marcador de alerta. */
export const ALERT_LAYERS = ['alerts-dot', 'alerts-icon', 'alerts-badge', 'alerts-badge-count'];

/** Id do alerta do primeiro marcador tocado, ou `null`. */
export function alertIdOf(features: readonly { properties?: Record<string, unknown> | null }[] | undefined): string | null {
  const id = features?.find((f) => typeof f.properties?.id === 'string')?.properties?.id;
  return typeof id === 'string' ? id : null;
}

/** Lado, em px lógicos, das imagens de glifo registradas no mapa. As camadas escalam com `icon-size`. */
export const GLYPH_IMAGE_SIZE = 24;

const glyphImage = (glyph: string) => `glyph-${glyph}`;
const alertImage = (type: string) => glyphImage(ALERT_ICONS[type] ?? 'alert');
const countGlyph = (n: number) => (n > 9 ? 'numeric-9-plus' : `numeric-${n}`);

/**
 * Glifos brancos do MaterialCommunityIcons que as camadas usam, por nome de imagem.
 * Cada plataforma rasteriza e registra no MapLibre (`Images` no nativo, `addImage` na web).
 */
export const MAP_GLYPHS: Record<string, string> = Object.fromEntries(
  [...Object.values(ALERT_ICONS), 'alert', ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(countGlyph)].map((g) => [glyphImage(g), g]),
);

export function buildSources(data: MapData): Record<keyof typeof SOURCE, FeatureCollection> {
  // Alternativas primeiro: a selecionada é desenhada por cima.
  const routes = [...data.routes].sort((a, b) => Number(a.selected) - Number(b.selected));
  return {
    routes: {
      type: 'FeatureCollection',
      features: routes.map((r) => ({
        type: 'Feature',
        properties: { id: r.id, selected: r.selected ? 1 : 0 },
        geometry: { type: 'LineString', coordinates: r.coords },
      })),
    },
    alerts: {
      type: 'FeatureCollection',
      // Alertas no mesmo ponto viram um marcador com o ícone do mais grave e a contagem.
      features: groupAlerts(data.alerts).map((g) => ({
        type: 'Feature',
        properties: {
          id: g.top.id,
          color: ALERT_COLORS[g.top.type] ?? '#DC2626',
          icon: alertImage(g.top.type),
          count: g.alerts.length,
          countIcon: glyphImage(countGlyph(g.alerts.length)),
          // Maior = desenhado por cima.
          sort: ALERT_SEVERITY.length - severityRank(g.top.type),
        },
        geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
      })),
    },
    spots: {
      type: 'FeatureCollection',
      features: data.slowSpots.map((s) => ({
        type: 'Feature',
        properties: { factor: s.factor },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    },
    points: {
      type: 'FeatureCollection',
      features: [
        ...(data.destination
          ? [{ type: 'Feature' as const, properties: { kind: 'dest' }, geometry: { type: 'Point' as const, coordinates: [data.destination.lon, data.destination.lat] } }]
          : []),
        ...data.stops.map((s) => ({
          type: 'Feature' as const,
          properties: { kind: 'stop' },
          geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        })),
        ...(data.puck
          ? [
              {
                type: 'Feature' as const,
                properties: {
                  kind: 'puck',
                  ...(data.puck.accuracy != null ? { accuracyPx22: metersToPixelsAtZoom22(data.puck.accuracy, data.puck.lat) } : {}),
                },
                geometry: { type: 'Point' as const, coordinates: [data.puck.lon, data.puck.lat] },
              },
            ]
          : []),
      ],
    },
  };
}

/** Camadas no formato da especificação de estilo do MapLibre (mesmo formato no web e no nativo). */
export function layerSpecs(theme: Theme) {
  const sel = ['==', ['get', 'selected'], 1] as const;
  // Contagem no canto superior direito do marcador, acompanhando o raio dele.
  const badgeOffset = ['interpolate', ['linear'], ['zoom'], 10, ['literal', [7, -7]], 16, ['literal', [10, -10]]];
  return [
    {
      id: 'spots-heat',
      source: SOURCE.spots,
      type: 'circle' as const,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 34],
        'circle-color': '#F97316',
        'circle-opacity': 0.22,
        'circle-blur': 0.6,
      },
    },
    {
      id: 'routes-casing',
      source: SOURCE.routes,
      type: 'line' as const,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', sel, theme.dark ? '#0B2A73' : '#0B3BB8', theme.dark ? '#1E293B' : '#64748B'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', sel, 7, 5], 16, ['case', sel, 15, 10]],
      },
    },
    {
      id: 'routes-line',
      source: SOURCE.routes,
      type: 'line' as const,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', sel, theme.primary, theme.routeAlt],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', sel, 4.5, 3], 16, ['case', sel, 10, 6.5]],
      },
    },
    {
      id: 'alerts-dot',
      source: SOURCE.alerts,
      type: 'circle' as const,
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 14],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 2.5,
      },
    },
    {
      id: 'alerts-icon',
      source: SOURCE.alerts,
      type: 'symbol' as const,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 13 / GLYPH_IMAGE_SIZE, 16, 19 / GLYPH_IMAGE_SIZE],
        // Alerta é aviso de segurança: nenhum some por colisão com outro símbolo.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'sort'],
      },
    },
    {
      id: 'alerts-badge',
      source: SOURCE.alerts,
      type: 'circle' as const,
      filter: ['>', ['get', 'count'], 1],
      layout: { 'circle-sort-key': ['get', 'sort'] },
      paint: {
        'circle-radius': 8,
        'circle-color': '#0E1726',
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 1.5,
        'circle-translate': badgeOffset,
      },
    },
    {
      id: 'alerts-badge-count',
      source: SOURCE.alerts,
      type: 'symbol' as const,
      filter: ['>', ['get', 'count'], 1],
      layout: {
        'icon-image': ['get', 'countIcon'],
        'icon-size': 13 / GLYPH_IMAGE_SIZE,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'sort'],
      },
      paint: { 'icon-translate': badgeOffset },
    },
    {
      // Círculo de incerteza em metros: o raio em pixels dobra a cada nível de zoom.
      id: 'points-accuracy',
      source: SOURCE.points,
      type: 'circle' as const,
      filter: ['all', ['==', ['get', 'kind'], 'puck'], ['has', 'accuracyPx22']],
      paint: {
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, 0, 22, ['get', 'accuracyPx22']],
        'circle-color': theme.primary,
        'circle-opacity': 0.12,
        'circle-stroke-color': theme.primary,
        'circle-stroke-opacity': 0.45,
        'circle-stroke-width': 1,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    },
    {
      // Sem precisão (navegação, que mostra o ponto na rota), fica o halo fixo de antes.
      id: 'points-halo',
      source: SOURCE.points,
      type: 'circle' as const,
      filter: ['all', ['==', ['get', 'kind'], 'puck'], ['!', ['has', 'accuracyPx22']]],
      paint: { 'circle-radius': 22, 'circle-color': theme.primary, 'circle-opacity': 0.18 },
    },
    {
      id: 'points-dot',
      source: SOURCE.points,
      type: 'circle' as const,
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'puck', 9, 'dest', 9, 7],
        'circle-color': ['match', ['get', 'kind'], 'puck', theme.primary, 'dest', '#E11D48', theme.learn],
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 3,
      },
    },
  ];
}
