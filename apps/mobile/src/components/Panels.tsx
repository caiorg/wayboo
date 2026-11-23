import { ALERT_TYPES, formatDurationPtBR, type AlertType, type FinishTripResponse, type Suggestion } from '@wayboo/core';
import { Pressable, StyleSheet, View } from 'react-native';
import type { ReportAccuracy } from '@/lib/gpsAccuracy';
import { ALERT_COLORS, ALERT_ICONS, ALERT_LABELS, useTheme } from '@/lib/theme';
import { Button, Card, Icon, T, type IconName } from './ui';

export function ReportSheet({
  accuracy,
  onReport,
  onClose,
}: {
  accuracy: ReportAccuracy;
  onReport: (type: AlertType) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  return (
    <Card style={{ gap: 14 }}>
      <View style={styles.row}>
        <T variant="title" style={{ flex: 1 }}>
          O que está acontecendo?
        </T>
        <Pressable accessibilityLabel="Fechar" onPress={onClose} hitSlop={10}>
          <Icon name="close" color={t.textMuted} />
        </Pressable>
      </View>
      {accuracy.ok ? null : (
        <View style={[styles.learnBox, { backgroundColor: t.surfaceAlt }]} accessibilityRole="alert">
          <Icon name="crosshairs-question" color={t.warning} size={20} />
          <T variant="caption" color={t.text} style={{ flex: 1 }}>
            {accuracy.message}
          </T>
        </View>
      )}
      <View style={styles.grid}>
        {ALERT_TYPES.map((type) => (
          <Pressable
            key={type}
            accessibilityRole="button"
            accessibilityLabel={ALERT_LABELS[type]}
            accessibilityState={{ disabled: !accuracy.ok }}
            disabled={!accuracy.ok}
            onPress={() => onReport(type)}
            style={({ pressed }) => [styles.cell, { backgroundColor: t.surfaceAlt, opacity: !accuracy.ok ? 0.4 : pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.circle, { backgroundColor: ALERT_COLORS[type] }]}>
              <Icon name={ALERT_ICONS[type] as IconName} color="#FFFFFF" size={24} />
            </View>
            <T variant="caption" color={t.text} style={{ textAlign: 'center' }}>
              {ALERT_LABELS[type]}
            </T>
          </Pressable>
        ))}
      </View>
      <T variant="caption">O alerta fica visível para outros motoristas e expira sozinho. Confirmações renovam a validade.</T>
    </Card>
  );
}

export function SuggestionCard({ s, onGo }: { s: Suggestion; onGo: () => void }) {
  const t = useTheme();
  const icon: IconName = s.place.kind === 'home' ? 'home-variant' : s.place.kind === 'work' ? 'briefcase' : 'map-marker-star';
  const delta = Math.round((s.durationS - s.usualDurationS) / 60);
  return (
    <Pressable accessibilityRole="button" onPress={onGo}>
      <Card style={styles.suggestion}>
        <View style={[styles.circle, { backgroundColor: t.learnSoft }]}>
          <Icon name={icon} color={t.learn} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="caption" color={t.learn} style={{ fontWeight: '700' }}>
            Costuma sair por volta das {s.typicalDeparture}
          </T>
          <T style={{ fontWeight: '700' }}>
            {s.place.label} · {formatDurationPtBR(s.durationS)}
            {Math.abs(delta) >= 3 ? <T color={delta > 0 ? t.warning : t.success}>{`  ${delta > 0 ? '+' : ''}${delta} min`}</T> : null}
          </T>
          <T variant="caption" numberOfLines={2}>
            {s.message}
          </T>
        </View>
        <Icon name="chevron-right" color={t.textMuted} />
      </Card>
    </Pressable>
  );
}

export function ArrivalCard({ result, onClose }: { result: FinishTripResponse | null; onClose: () => void }) {
  const t = useTheme();
  const improved = result && result.arrived && result.errorBasePct - result.errorLearnedPct >= 1;
  return (
    <Card style={{ gap: 12 }}>
      <View style={styles.row}>
        <View style={[styles.circle, { backgroundColor: t.dark ? '#0F2E25' : '#E7F7F0' }]}>
          <Icon name="flag-checkered" color={t.success} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="title">Você chegou</T>
          {result ? <T variant="caption">Viagem de {formatDurationPtBR(result.actualS)}</T> : <T variant="caption">Simulação concluída</T>}
        </View>
      </View>
      {result ? (
        <View style={[styles.learnBox, { backgroundColor: t.learnSoft }]}>
          <Icon name="brain" color={t.learn} size={18} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="caption" color={t.text}>
              {result.message}
            </T>
            {improved ? (
              <T variant="caption" color={t.learn} style={{ fontWeight: '700' }}>
                O aprendizado reduziu o erro em {(result.errorBasePct - result.errorLearnedPct).toFixed(0)} pontos.
              </T>
            ) : null}
            {result.anomalies > 0 ? (
              <T variant="caption" color={t.warning}>
                {result.anomalies} trecho(s) bem mais lentos que o esperado foram registrados.
              </T>
            ) : null}
          </View>
        </View>
      ) : null}
      <Button label="Fechar" kind="secondary" onPress={onClose} />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: { width: '22%', minWidth: 72, flexGrow: 1, alignItems: 'center', gap: 6, paddingVertical: 12, borderRadius: 16 },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  learnBox: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14 },
});
