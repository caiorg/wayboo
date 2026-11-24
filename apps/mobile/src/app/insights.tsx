import type { Insights, KnownPlace } from '@wayboo/core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Chip, Icon, T } from '@/components/ui';
import { api } from '@/lib/api';
import { useTheme } from '@/lib/theme';

export default function InsightsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrating, setNarrating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.insights());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const narrate = async () => {
    setNarrating(true);
    try {
      const r = await api.narrative();
      setNarrative(r.text ?? 'Configure um provedor de IA na API (AI_PROVIDER) ou a sua chave em Ajustes para gerar o resumo.');
    } catch (e) {
      setNarrative(e instanceof Error ? e.message : 'Falha');
    } finally {
      setNarrating(false);
    }
  };

  const setKind = async (p: KnownPlace, kind: KnownPlace['kind']) => {
    await api.updatePlace(p.id, { kind }).catch(() => undefined);
    void load();
  };

  if (!data) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        {error ? <T color={t.danger}>{error}</T> : <ActivityIndicator color={t.primary} />}
      </View>
    );
  }

  const acc = data.accuracy;
  const recent = acc.slice(-10);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const learnedErr = avg(recent.map((a) => a.errorLearnedPct));
  const baseErr = avg(recent.map((a) => a.errorBasePct));
  const maxErr = Math.max(10, ...acc.map((a) => Math.max(a.errorBasePct, a.errorLearnedPct)));

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
    >
      <View style={styles.stats}>
        <Stat label="Viagens" value={String(data.trips)} />
        <Stat label="Km aprendidos" value={data.kmDriven.toFixed(0)} />
        <Stat label="Trechos" value={String(data.learnedSegments)} />
      </View>

      <Card style={{ gap: 10 }}>
        <View style={styles.row}>
          <Icon name="creation" color={t.learn} />
          <T variant="title" style={{ flex: 1 }}>
            Resumo do copiloto
          </T>
        </View>
        {narrative ? <T variant="caption" color={t.text}>{narrative}</T> : null}
        <Button label={narrative ? 'Atualizar resumo' : 'Gerar resumo com IA'} kind="learn" icon="creation" onPress={() => void narrate()} loading={narrating} />
      </Card>

      <Card style={{ gap: 10 }}>
        <T variant="title">Precisão do ETA</T>
        {acc.length ? (
          <>
            <T variant="caption">
              Últimas {recent.length} viagens: erro médio de {learnedErr.toFixed(0)}% com aprendizado, contra {baseErr.toFixed(0)}% do roteador sozinho.
            </T>
            <View style={styles.chart} accessibilityLabel="Gráfico de erro do ETA por viagem">
              {acc.slice(-30).map((a) => (
                <View key={a.tripId} style={styles.barGroup}>
                  <View style={[styles.bar, { height: `${(a.errorBasePct / maxErr) * 100}%`, backgroundColor: t.routeAlt }]} />
                  <View style={[styles.bar, { height: `${(a.errorLearnedPct / maxErr) * 100}%`, backgroundColor: t.learn }]} />
                </View>
              ))}
            </View>
            <View style={styles.row}>
              <Legend color={t.routeAlt} label="Roteador" />
              <Legend color={t.learn} label="Aprendido" />
            </View>
          </>
        ) : (
          <T variant="caption">Complete viagens até o destino para medir a precisão.</T>
        )}
      </Card>

      <Card style={{ gap: 10 }}>
        <T variant="title">Seus lugares</T>
        {data.places.length ? (
          data.places.map((p) => (
            <View key={p.id} style={styles.place}>
              <Icon name={p.kind === 'home' ? 'home-variant' : p.kind === 'work' ? 'briefcase' : 'map-marker'} color={t.learn} />
              <View style={{ flex: 1 }}>
                <T>{p.label}</T>
                <T variant="caption">{p.visits} chegadas</T>
              </View>
              <View style={styles.row}>
                <Chip label="Casa" selected={p.kind === 'home'} onPress={() => void setKind(p, 'home')} />
                <Chip label="Trabalho" selected={p.kind === 'work'} onPress={() => void setKind(p, 'work')} />
              </View>
            </View>
          ))
        ) : (
          <T variant="caption">Os lugares aparecem sozinhos depois de algumas viagens.</T>
        )}
      </Card>

      {data.routines.length ? (
        <Card style={{ gap: 8 }}>
          <T variant="title">Rotinas detectadas</T>
          {data.routines.map((r) => (
            <View key={`${r.origin}-${r.destination}-${r.dayType}`} style={styles.row}>
              <Icon name="calendar-clock" color={t.learn} size={18} />
              <T variant="caption" color={t.text} style={{ flex: 1 }}>
                {r.origin} → {r.destination}, {r.dayType}, saída {r.typicalDeparture} ({r.trips} viagens)
              </T>
            </View>
          ))}
        </Card>
      ) : null}

      {data.tradeoffs.length ? (
        <Card style={{ gap: 8 }}>
          <T variant="title">Preferências aprendidas</T>
          {data.tradeoffs.map((x) => (
            <View key={x.feature} style={styles.row}>
              <Icon name="tune-variant" color={t.learn} size={18} />
              <T variant="caption" color={t.text} style={{ flex: 1 }}>
                {x.label}
              </T>
            </View>
          ))}
        </Card>
      ) : null}

      {data.slowSpots.length ? (
        <Card style={{ gap: 8 }}>
          <T variant="title">Lentidão recorrente</T>
          {data.slowSpots.map((s) => (
            <View key={`${s.lat},${s.lon},${s.when}`} style={styles.row}>
              <Icon name="traffic-light" color={t.warning} size={18} />
              <T variant="caption" color={t.text} style={{ flex: 1 }}>
                {s.when}: {s.factor.toFixed(1)}x o tempo de via livre ({s.observations} observações)
              </T>
            </View>
          ))}
        </Card>
      ) : null}

      {data.contextFactors.length ? (
        <Card style={{ gap: 8 }}>
          <T variant="title">Fatores que afetam seu ETA</T>
          {data.contextFactors.map((c) => (
            <View key={c.label} style={styles.row}>
              <Icon name="weather-pouring" color={t.primary} size={18} />
              <T variant="caption" color={t.text} style={{ flex: 1 }}>
                {c.label}: {c.impactPct >= 0 ? '+' : ''}
                {c.impactPct.toFixed(0)}% no tempo de viagem ({c.observations} viagens)
              </T>
            </View>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card style={{ flex: 1, alignItems: 'center', padding: 14 }}>
      <T variant="display">{value}</T>
      <T variant="caption">{label}</T>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.row}>
      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />
      <T variant="caption">{label}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { padding: 16, gap: 14, maxWidth: 760, width: '100%', alignSelf: 'center' },
  stats: { flexDirection: 'row', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chart: { height: 120, flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  barGroup: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', height: '100%', gap: 1 },
  bar: { flex: 1, borderTopLeftRadius: 3, borderTopRightRadius: 3, minHeight: 2 },
  place: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
