import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Camera, GeoJSONSource, Images, Layer, Map, type CameraRef, type ImageEntry, type LayerProps } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { buildSources, GLYPH_IMAGE_SIZE, layerSpecs, MAP_GLYPHS, SOURCE, type MapViewProps } from './mapData';

type GlyphName = keyof typeof MaterialCommunityIcons.glyphMap;

/** Rasteriza os glifos de MAP_GLYPHS uma vez por sessão (o expo-font devolve um PNG em cache). */
let glyphImages: Promise<Record<string, ImageEntry>> | null = null;
function loadGlyphImages(): Promise<Record<string, ImageEntry>> {
  glyphImages ??= Promise.all(
    Object.entries(MAP_GLYPHS).map(async ([id, glyph]) => {
      const src = await MaterialCommunityIcons.getImageSource(glyph as GlyphName, GLYPH_IMAGE_SIZE, '#FFFFFF');
      return src ? ([[id, { source: src }]] as const) : [];
    }),
  )
    .then((entries) => Object.fromEntries(entries.flat()))
    .catch((e: unknown) => {
      glyphImages = null;
      throw e;
    });
  return glyphImages;
}

/** Implementação nativa (iOS/Android). A versão web fica em MapView.web.tsx. */
export function MapView({ theme, data, camera, initialCenter, onLongPress, onUserPan }: MapViewProps) {
  const cameraRef = useRef<CameraRef>(null);
  const sources = useMemo(() => buildSources(data), [data]);
  const layers = useMemo(() => layerSpecs(theme), [theme]);
  const [images, setImages] = useState<Record<string, ImageEntry>>({});

  useEffect(() => {
    let live = true;
    // Sem as imagens, o mapa mostra só as bolinhas coloridas dos alertas.
    loadGlyphImages()
      .then((imgs) => live && setImages(imgs))
      .catch((e: unknown) => console.warn('Ícones dos alertas indisponíveis', e));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const c = cameraRef.current;
    if (!c || !camera) return;
    if (camera.type === 'fit') {
      c.fitBounds(camera.bounds, { padding: camera.padding, duration: 700 });
    } else if (camera.type === 'follow') {
      c.easeTo({ center: camera.center, bearing: camera.bearing, zoom: camera.zoom, pitch: camera.pitch, duration: 900, easing: 'linear' });
    } else {
      c.flyTo({ center: camera.center, zoom: camera.zoom, duration: 800 });
    }
  }, [camera]);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={theme.mapStyle}
      logo={false}
      attribution
      attributionPosition={{ bottom: 8, left: 8 }}
      compass={false}
      onLongPress={(e) => onLongPress?.({ lon: e.nativeEvent.lngLat[0], lat: e.nativeEvent.lngLat[1] })}
      onRegionWillChange={(e) => {
        if (e.nativeEvent.userInteraction) onUserPan?.();
      }}
    >
      <Camera ref={cameraRef} initialViewState={{ center: initialCenter, zoom: 13 }} />
      <Images images={images} />
      {(Object.keys(SOURCE) as (keyof typeof SOURCE)[]).map((key) => (
        <GeoJSONSource key={key} id={SOURCE[key]} data={sources[key]}>
          {layers
            .filter((l) => l.source === SOURCE[key])
            .map(({ source: _source, ...l }) => (
              <Layer key={l.id} {...(l as unknown as LayerProps)} />
            ))}
        </GeoJSONSource>
      ))}
    </Map>
  );
}
