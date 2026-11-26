import { ALERT_TYPES, formatDurationPtBR, type AlertType, type FinishTripResponse, type RoadAlert, type Suggestion } from '@wayboo/core';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { timeAgoPtBR, voteStatus } from '@/lib/alertGroups';
import type { ReportAccuracy } from '@/lib/gpsAccuracy';
import { ALERT_COLORS, ALERT_ICONS, ALERT_LABELS, useTheme } from '@/lib/theme';
import { Button, Card, Chip, Icon, T, type IconName } from './ui';

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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Folha aberta ao tocar num marcador: os alertas do ponto, com votos e botões de confirmar ou negar. */
export function AlertSheet({
  alerts,
  pending,
  onVote,
  onClose,
}: {
  /** Do mais grave para o menos grave, como no marcador. */
  alerts: RoadAlert[];
  /** Votos a caminho do servidor, com a direção. */
  pending: ReadonlyMap<string, 'up' | 'down'>;
  onVote: (alert: RoadAlert, up: boolean) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const { height } = useWindowDimensions();
  const first = alerts[0];
  const title = alerts.length === 1 && first ? ALERT_LABELS[first.type] : `${alerts.length} alertas neste ponto`;
  return (
    <Card style={{ gap: 12 }}>
      <View style={styles.row}>
        <View style={{ flex: 1, gap: 2 }}>
          <View accessibilityRole="header">
            <T variant="title">{title}</T>
          </View>
          {alerts.some((a) => voteStatus(a) === 'open') ? (
            <T variant="caption">Confirmar renova a validade. Negações tiram o alerta do mapa. O voto não pode ser trocado.</T>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Fechar" onPress={onClose} hitSlop={10}>
          <Icon name="close" color={t.textMuted} />
        </Pressable>
      </View>
      {/* Em telas baixas, a lista rola em vez de a folha cobrir o mapa inteiro. */}
      <ScrollView style={{ maxHeight: Math.min(360, height * 0.42) }} contentContainerStyle={{ gap: 10 }}>
        {alerts.map((a) => (
          <AlertRow key={a.id} alert={a} pending={pending.get(a.id) ?? null} onVote={(up) => onVote(a, up)} />
        ))}
      </ScrollView>
    </Card>
  );
}

function AlertRow({ alert: a, pending, onVote }: { alert: RoadAlert; pending: 'up' | 'down' | null; onVote: (up: boolean) => void }) {
  const t = useTheme();
  const status = voteStatus(a);
  const label = ALERT_LABELS[a.type]?.toLowerCase() ?? 'alerta';
  const votes = `${plural(a.upvotes, 'confirmação', 'confirmações')} · ${plural(a.downvotes, 'negação', 'negações')}`;
  return (
    <View style={[styles.alertRow, { backgroundColor: t.surfaceAlt }]}>
      <View style={styles.row}>
        <View style={[styles.circle, { backgroundColor: ALERT_COLORS[a.type] }]}>
          <Icon name={ALERT_ICONS[a.type] as IconName} color="#FFFFFF" size={22} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T style={{ fontWeight: '700' }}>{ALERT_LABELS[a.type]}</T>
          <T variant="caption">
            {timeAgoPtBR(a.createdAt)} · {votes}
          </T>
          {a.note ? (
            <T variant="caption" color={t.text} numberOfLines={3}>
              {a.note}
            </T>
          ) : null}
        </View>
      </View>
      {status === 'open' ? (
        <View style={styles.voteRow}>
          <Button
            label="Confirmar"
            accessibilityLabel={`Confirmar ${label}`}
            icon="thumb-up-outline"
            kind="secondary"
            loading={pending === 'up'}
            disabled={pending !== null}
            onPress={() => onVote(true)}
            style={[styles.voteButton, { backgroundColor: t.surface }]}
          />
          <Button
            label="Negar"
            accessibilityLabel={`Negar ${label}`}
            icon="thumb-down-outline"
            kind="secondary"
            loading={pending === 'down'}
            disabled={pending !== null}
            onPress={() => onVote(false)}
            style={[styles.voteButton, { backgroundColor: t.surface }]}
          />
        </View>
      ) : (
        <View style={{ flexDirection: 'row' }}>
          {status === 'mine' ? (
            <Chip label="Você avisou" icon="account-check" tone="primary" />
          ) : status === 'up' ? (
            <Chip label="Você confirmou" icon="thumb-up" tone="success" />
          ) : (
            <Chip label="Você negou" icon="thumb-down" tone="neutral" />
          )}
        </View>
      )}
    </View>
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
  alertRow: { gap: 10, padding: 12, borderRadius: 16 },
  voteRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  voteButton: { flexGrow: 1, flexBasis: 120, height: 44, paddingHorizontal: 12 },
});
