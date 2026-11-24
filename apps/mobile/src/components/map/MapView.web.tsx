import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Map as MlMap, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { ALERT_LAYERS, alertIdOf, buildSources, GLYPH_IMAGE_SIZE, layerSpecs, MAP_GLYPHS, SOURCE, type MapViewProps } from './mapData';

// O Metro não resolve o worker que o maplibre-gl 6 carrega via import.meta.url.
// O postinstall copia o arquivo para public/, que o Expo serve na raiz.
setWorkerUrl('/maplibre-gl-worker.mjs');

type GlyphImage = { data: ImageData; pixelRatio: number };

/** O expo-font não rasteriza glifos na web; desenha cada um num canvas com a fonte de ícones. */
let glyphImages: Promise<Record<string, GlyphImage>> | null = null;
function loadGlyphImages(): Promise<Record<string, GlyphImage>> {
  glyphImages ??= (async () => {
    const family = MaterialCommunityIcons.getFontFamily();
    const pixelRatio = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const side = GLYPH_IMAGE_SIZE * pixelRatio;
    await MaterialCommunityIcons.loadFont();
    await document.fonts.load(`${side}px "${family}"`);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D indisponível');
    const glyphMap = MaterialCommunityIcons.glyphMap as Record<string, number>;
    const out: Record<string, GlyphImage> = {};
    for (const [id, glyph] of Object.entries(MAP_GLYPHS)) {
      const code = glyphMap[glyph];
      if (code === undefined) continue;
      ctx.clearRect(0, 0, side, side);
      ctx.font = `${side}px "${family}"`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String.fromCodePoint(code), side / 2, side / 2);
      out[id] = { data: ctx.getImageData(0, 0, side, side), pixelRatio };
    }
    return out;
  })().catch((e: unknown) => {
    glyphImages = null;
    throw e;
  });
  return glyphImages;
}

/** Implementação web com maplibre-gl. Mesmas camadas e fontes da versão nativa. */
export function MapView({ theme, data, camera, initialCenter, onLongPress, onUserPan, onAlertPress }: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const latest = useRef({ data, theme, onLongPress, onUserPan, onAlertPress });
  latest.current = { data, theme, onLongPress, onUserPan, onAlertPress };

  const install = (m: MlMap) => {
    const sources = buildSources(latest.current.data);
    for (const key of Object.keys(SOURCE) as (keyof typeof SOURCE)[]) {
      if (!m.getSource(SOURCE[key])) m.addSource(SOURCE[key], { type: 'geojson', data: sources[key] });
    }
    for (const l of layerSpecs(latest.current.theme)) {
      if (!m.getLayer(l.id)) m.addLayer(l as unknown as LayerSpecification);
    }
    // Trocar o estilo apaga as imagens também. Sem elas, ficam só as bolinhas coloridas.
    loadGlyphImages()
      .then((imgs) => {
        if (map.current !== m) return;
        for (const [id, img] of Object.entries(imgs)) {
          if (!m.hasImage(id)) m.addImage(id, img.data, { pixelRatio: img.pixelRatio });
        }
      })
      .catch((e: unknown) => console.warn('Ícones dos alertas indisponíveis', e));
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new MlMap({
      container: el.current,
      style: theme.mapStyle,
      center: initialCenter,
      zoom: 13,
      attributionControl: { compact: true },
    });
    map.current = m;
    m.on('style.load', () => install(m));
    m.on('contextmenu', (e: MapMouseEvent) => latest.current.onLongPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    m.on('dragstart', () => latest.current.onUserPan?.());
    // Os ouvintes por camada valem também para as camadas recriadas depois de trocar o estilo.
    m.on('click', ALERT_LAYERS, (e) => {
      const id = alertIdOf(e.features);
      if (id) latest.current.onAlertPress?.(id);
    });
    m.on('mouseenter', ALERT_LAYERS, () => (m.getCanvas().style.cursor = 'pointer'));
    m.on('mouseleave', ALERT_LAYERS, () => (m.getCanvas().style.cursor = ''));
    return () => {
      m.remove();
      map.current = null;
    };
    // O mapa é criado uma vez; tema e dados são aplicados pelos efeitos abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Trocar o estilo apaga fontes/camadas; o handler de style.load as recria.
    map.current?.setStyle(theme.mapStyle);
  }, [theme.mapStyle]);

  useEffect(() => {
    const m = map.current;
    // Não usar isStyleLoaded(): ele fica false enquanto tiles carregam. Se a fonte ainda
    // não existe, o handler de style.load instala os dados mais recentes.
    if (!m) return;
    const sources = buildSources(data);
    for (const key of Object.keys(SOURCE) as (keyof typeof SOURCE)[]) {
      (m.getSource(SOURCE[key]) as GeoJSONSource | undefined)?.setData(sources[key]);
    }
  }, [data]);

  useEffect(() => {
    const m = map.current;
    if (!m || !camera) return;
    if (camera.type === 'fit') {
      m.fitBounds(
        [
          [camera.bounds[0], camera.bounds[1]],
          [camera.bounds[2], camera.bounds[3]],
        ],
        { padding: camera.padding, duration: 700, bearing: 0, pitch: 0 },
      );
    } else if (camera.type === 'follow') {
      m.easeTo({ center: camera.center, bearing: camera.bearing, zoom: camera.zoom, pitch: camera.pitch, duration: 900, easing: (t) => t });
    } else {
      m.flyTo({ center: camera.center, zoom: camera.zoom, duration: 800 });
    }
  }, [camera]);

  return <div ref={el} style={{ position: 'absolute', inset: 0 }} />;
}
