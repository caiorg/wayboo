import { formatDistancePtBR, formatDurationPtBR, routeVia, type Brief, type PlanResponse, type StopSuggestion } from '@wayboo/core';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { OfflineRouteButton } from './OfflineRouteButton';
import { Button, Card, Chip, Icon, T } from './ui';

const clock = (epoch: number) => new Date(epoch).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const LEVEL: Record<PlanResponse['learningLevel'], { label: string; tone: 'neutral' | 'learn' }> = {
  nenhum: { label: 'ETA do roteador', tone: 'neutral' },
  inicial: { label: 'Aprendendo seu trajeto', tone: 'learn' },
  bom: { label: 'ETA aprendido', tone: 'learn' },
  alto: { label: 'ETA aprendido · alta confiança', tone: 'learn' },
};

export function RouteSheet({
  plan,
  selected,
  onSelect,
  brief,
  briefLoading,
  stops,
  message,
  onStart,
  onClose,
}: {
  plan: PlanResponse;
  selected: number;
  onSelect: (i: number) => void;
  brief: Brief | null;
  briefLoading: boolean;
  stops: StopSuggestion[];
  message: string | null;
  onStart: (simulate: boolean) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const level = LEVEL[plan.learningLevel];
  const now = plan.departures[0];
  const best = plan.departures.reduce<(typeof plan.departures)[number] | undefined>(
    (a, b) => (!a || b.durationS < a.durationS ? b : a),
    undefined,
  );
  const saves = now && best ? Math.round((now.durationS - best.durationS) / 60) : 0;

  return (
    <Card style={styles.sheet}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <T variant="caption">Destino</T>
          <T variant="title" numberOfLines={1}>
            {plan.destinationPlace?.label ?? plan.destinationName ?? 'Ponto no mapa'}
          </T>
        </View>
        <Pressable accessibilityLabel="Fechar rotas" onPress={onClose} hitSlop={10}>
          <Icon name="close" color={t.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }} showsVerticalScrollIndicator={false}>
        {message ? <T variant="caption">{message}</T> : null}

        <View style={[styles.brief, { backgroundColor: t.learnSoft }]}>
          <Icon name="creation" color={t.learn} size={18} />
          <View style={{ flex: 1, gap: 2 }}>
            {brief ? (
              <>
                <T style={{ fontWeight: '700' }} color={t.text}>
                  {brief.headline}
                </T>
                <T variant="caption" color={t.text}>
                  {brief.explanation}
                </T>
                {brief.warnings.map((w) => (
                  <T key={w} variant="caption" color={t.warning}>
                    • {w}
                  </T>
                ))}
                {brief.departureAdvice ? (
                  <T variant="caption" color={t.learn} style={{ fontWeight: '700' }}>
                    {brief.departureAdvice}
                  </T>
                ) : null}
              </>
            ) : (
              <T variant="caption" color={t.text}>
                {briefLoading ? 'Copiloto analisando rotas, trânsito aprendido e alertas…' : plan.reason}
              </T>
            )}
          </View>
        </View>

        {stops.length ? (
          <View style={styles.chips}>
            {stops.map((s) => (
              <Chip key={s.name} icon="map-marker-plus" tone="learn" label={`${s.category}: ${s.name}`} />
            ))}
          </View>
        ) : null}

        {plan.routes.map((r, i) => {
          const active = i === selected;
          const deltaBase = Math.round((r.eta.durationS - r.eta.baseDurationS) / 60);
          const via = routeVia(r.route.maneuvers);
          const isRec = i === (brief?.recommendedIndex ?? plan.recommendedIndex);
          return (
            <Pressable
              key={r.route.id}
              onPress={() => onSelect(i)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.route, { borderColor: active ? t.primary : t.border, backgroundColor: active ? (t.dark ? '#14234A' : '#F2F6FF') : t.surface }]}
            >
              <View style={styles.routeTop}>
                <T variant="display" color={active ? t.primary : t.text}>
                  {formatDurationPtBR(r.eta.durationS)}
                </T>
                <View style={{ alignItems: 'flex-end' }}>
                  <T variant="caption">Chegada {clock(plan.departAt + r.eta.durationS * 1000)}</T>
                  <T variant="caption">{formatDistancePtBR(r.route.distanceM)}</T>
                </View>
              </View>
              <T variant="caption" numberOfLines={1}>
                {via.length ? `via ${via.join(', ')}` : 'Rota alternativa'} · entre {formatDurationPtBR(r.eta.p10S)} e{' '}
                {formatDurationPtBR(r.eta.p90S)}
              </T>
              <View style={styles.chips}>
                {isRec ? <Chip label="Recomendada" tone="primary" icon="star" /> : null}
                {r.tags.map((tag) => (
                  <Chip
                    key={tag}
                    label={tag}
                    tone={tag.includes('alerta') || tag === 'Pedágio' ? 'warning' : tag === 'Seu caminho de sempre' ? 'learn' : 'success'}
                  />
                ))}
                {Math.abs(deltaBase) >= 2 ? (
                  <Chip
                    icon="brain"
                    tone="learn"
                    label={`${deltaBase > 0 ? '+' : ''}${deltaBase} min vs roteador`}
                  />
                ) : null}
              </View>
              {active && r.eta.factors.length ? (
                <View style={{ gap: 2, marginTop: 4 }}>
                  {r.eta.factors.map((f) => (
                    <T key={f.label} variant="caption">
                      {f.deltaS >= 0 ? '+' : '−'}
                      {formatDurationPtBR(Math.abs(f.deltaS))} · {f.label}
                    </T>
                  ))}
                </View>
              ) : null}
            </Pressable>
          );
        })}

        {saves >= 3 && best ? (
          <View style={[styles.brief, { backgroundColor: t.surfaceAlt }]}>
            <Icon name="clock-fast" color={t.success} size={18} />
            <T variant="caption" color={t.text} style={{ flex: 1 }}>
              Saindo às {clock(best.departAt)} a viagem leva {formatDurationPtBR(best.durationS)} ({saves} min a menos).
            </T>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Chip icon="brain" tone={level.tone} label={level.label} />
        {plan.context.weather ? <Chip icon="weather-partly-cloudy" label={plan.context.weather.description} /> : null}
      </View>
      {plan.routes[selected] ? <OfflineRouteButton route={plan.routes[selected].route} /> : null}
      <View style={styles.actions}>
        <Button label="Simular" kind="secondary" icon="play-speed" onPress={() => onStart(true)} style={{ flex: 1 }} />
        <Button label="Iniciar" icon="navigation-variant" onPress={() => onStart(false)} style={{ flex: 2 }} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: 12, paddingBottom: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brief: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14 },
  route: { borderWidth: 2, borderRadius: 16, padding: 12, gap: 6 },
  routeTop: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', gap: 10 },
});
