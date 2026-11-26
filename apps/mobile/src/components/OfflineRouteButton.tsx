import type { Route } from '@wayboo/core';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { offlineSupported } from '@/lib/offlineMaps';
import { downloadNextPart, prepareOfflineRoute, useOfflineRoute } from '@/lib/offlineRoute';
import { useMapStyles } from '@/lib/theme';
import { Button, T } from './ui';

/** Baixa o corredor da rota escolhida para o mapa aparecer sem rede. Cada toque baixa uma parte. */
export function OfflineRouteButton({ route }: { route: Route }) {
  const { light, dark } = useMapStyles();
  const styles = useMemo(() => [...new Set([light, dark])], [light, dark]);
  const { routeId, parts, done, ready, active, deleting, message } = useOfflineRoute();

  useEffect(() => {
    if (offlineSupported) void prepareOfflineRoute(route, styles);
  }, [route, styles]);

  if (!offlineSupported || routeId !== route.id || parts.length === 0) return null;
  const total = parts.length;
  const saved = done.length === total;
  const next = parts.findIndex((_, i) => !done.includes(i + 1)) + 1;
  const mine = active?.routeId === route.id ? active : null;
  const label = mine
    ? `Baixando parte ${mine.part} de ${total} · ${mine.percentage}%`
    : active
      ? 'Outro mapa está sendo baixado'
      : deleting
        ? 'Apagando mapas salvos'
        : saved
          ? 'Mapa da rota salvo'
          : total === 1
            ? 'Baixar mapa da rota'
            : `Baixar parte ${next} de ${total} do mapa`;

  return (
    <View style={{ gap: 6 }}>
      <Button
        label={label}
        kind="secondary"
        icon={saved ? 'map-check' : 'download'}
        loading={mine !== null || !ready}
        disabled={saved || active !== null || deleting}
        onPress={() => void downloadNextPart(styles)}
      />
      {message ? <T variant="caption">{message}</T> : null}
    </View>
  );
}
