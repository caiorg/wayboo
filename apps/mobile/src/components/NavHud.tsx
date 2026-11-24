import {
  formatDistancePtBR,
  formatDurationPtBR,
  maneuverIcon,
  upcomingLanes,
  type LaneIndication,
  type LaneView,
  type ManeuverIcon,
  type NavState,
} from '@wayboo/core';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme';
import { Card, Chip, Icon, IconButton, T, type IconName } from './ui';

const ICON: Record<ManeuverIcon, IconName> = {
  straight: 'arrow-up',
  right: 'arrow-right-top',
  left: 'arrow-left-top',
  'slight-right': 'arrow-top-right',
  'slight-left': 'arrow-top-left',
  'sharp-right': 'arrow-right-bottom',
  'sharp-left': 'arrow-left-bottom',
  uturn: 'arrow-u-left-top',
  roundabout: 'rotate-left',
  merge: 'call-merge',
  ferry: 'ferry',
  arrive: 'flag-checkered',
};

const LANE_ICON: Record<LaneIndication, IconName> = {
  uturn: 'arrow-u-left-top',
  'sharp-left': 'arrow-left-bottom',
  left: 'arrow-left-top',
  'slight-left': 'arrow-top-left',
  'merge-left': 'arrow-collapse-left',
  through: 'arrow-up',
  'merge-right': 'arrow-collapse-right',
  'slight-right': 'arrow-top-right',
  right: 'arrow-right-top',
  'sharp-right': 'arrow-right-bottom',
};

const LANE_LABEL: Record<LaneIndication, string> = {
  uturn: 'retorno',
  'sharp-left': 'esquerda fechada',
  left: 'esquerda',
  'slight-left': 'levemente à esquerda',
  'merge-left': 'convergência à esquerda',
  through: 'em frente',
  'merge-right': 'convergência à direita',
  'slight-right': 'levemente à direita',
  right: 'direita',
  'sharp-right': 'direita fechada',
};

function laneLabel(l: LaneView, i: number): string {
  const arrows = l.indications.length ? l.indications.map((d) => LANE_LABEL[d]).join(', ') : 'sem marcação';
  const state = l.state === 'active' ? ', recomendada' : l.state === 'valid' ? ', também serve' : '';
  return `Faixa ${i + 1}: ${arrows}${state}`;
}

/** Faixas da próxima manobra. A faixa recomendada fica clara; as que também servem ficam contornadas. */
function LaneStrip({ lanes, background }: { lanes: LaneView[]; background: string }) {
  // Sem recomendação do roteador, todas as setas ficam claras; com ela, apagam as que não seguem a rota.
  const guided = lanes.some((l) => l.state !== 'other');
  const arrowColor = (l: LaneView, d: LaneIndication) => {
    if (!guided) return '#CFF7E8';
    if (l.use !== d) return '#7FB8A4';
    return l.state === 'active' ? '#0B6B4F' : '#FFFFFF';
  };
  return (
    <View
      style={[styles.lanes, { backgroundColor: background }]}
      accessible
      accessibilityLabel={`Faixas da próxima manobra, da esquerda para a direita. ${lanes.map(laneLabel).join('. ')}`}
    >
      {lanes.map((l, i) => (
        <View
          key={i}
          style={[
            styles.lane,
            l.state === 'active' && { backgroundColor: '#FFFFFF' },
            l.state === 'valid' && { borderColor: '#FFFFFF' },
          ]}
        >
          {l.indications.length ? (
            l.indications.map((d) => (
              <Icon key={d} name={LANE_ICON[d]} size={l.indications.length > 1 ? 18 : 22} color={arrowColor(l, d)} />
            ))
          ) : (
            <View style={styles.laneBlank} />
          )}
        </View>
      ))}
    </View>
  );
}

export function NavBanner({ nav, rerouting, simulated }: { nav: NavState | null; rerouting: boolean; simulated: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const m = nav?.nextManeuver;
  const lanes = nav ? upcomingLanes(nav) : null;
  return (
    <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
      <View style={[styles.banner, { backgroundColor: t.dark ? '#0E3A2F' : '#0B6B4F' }]}>
        <Icon name={m ? ICON[maneuverIcon(m.type)] : 'navigation-variant'} color="#FFFFFF" size={44} />
        <View style={{ flex: 1 }}>
          <T variant="display" color="#FFFFFF">
            {nav ? formatDistancePtBR(nav.distanceToManeuverM) : '…'}
          </T>
          <T color="#E6FFF5" numberOfLines={2} style={{ fontSize: 17, fontWeight: '600' }}>
            {m?.instruction ?? 'Aguardando GPS'}
          </T>
        </View>
      </View>
      {lanes ? <LaneStrip lanes={lanes} background={t.dark ? '#0A2A22' : '#08533D'} /> : null}
      {nav?.thenManeuver ? (
        <View style={[styles.then, { backgroundColor: t.dark ? '#0A2A22' : '#08533D' }]}>
          <T variant="caption" color="#CFF7E8">
            Depois
          </T>
          <Icon name={ICON[maneuverIcon(nav.thenManeuver.type)]} color="#CFF7E8" size={18} />
        </View>
      ) : null}
      <View style={styles.pills}>
        {rerouting ? <Chip icon="refresh" tone="warning" label="Recalculando rota" /> : null}
        {simulated ? <Chip icon="play-speed" tone="primary" label="Simulação (não aprende)" /> : null}
        {nav?.currentStreet ? <Chip label={nav.currentStreet} /> : null}
      </View>
    </View>
  );
}

export function NavBottomBar({
  nav,
  muted,
  onReport,
  onMute,
  onStop,
}: {
  nav: NavState | null;
  muted: boolean;
  onReport: () => void;
  onMute: () => void;
  onStop: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const pace = nav?.paceRatio ?? 1;
  return (
    <View style={[styles.bottomWrap, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
      <Card style={styles.bottom}>
        <IconButton icon="close" label="Encerrar navegação" onPress={onStop} color={t.danger} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T variant="title" color={t.success}>
            {nav ? new Date(nav.arrivalAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--'}
          </T>
          <T variant="caption">
            {nav ? `${formatDurationPtBR(nav.remainingS)} · ${formatDistancePtBR(nav.remainingM)}` : 'calculando'}
          </T>
          {Math.abs(pace - 1) > 0.12 ? (
            <T variant="caption" color={t.learn}>
              {pace > 1 ? 'Mais lento que o previsto' : 'Mais rápido que o previsto'}, ETA ajustado
            </T>
          ) : null}
        </View>
        <IconButton icon={muted ? 'volume-off' : 'volume-high'} label={muted ? 'Ativar voz' : 'Silenciar voz'} onPress={onMute} />
        <IconButton icon="alert-plus" label="Reportar" onPress={onReport} color={t.warning} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, gap: 6 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 22 },
  then: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  lanes: { flexDirection: 'row', alignSelf: 'center', gap: 4, padding: 6, borderRadius: 14 },
  lane: {
    minWidth: 38,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  laneBlank: { width: 3, height: 18, borderRadius: 2, backgroundColor: '#7FB8A4' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  bottomWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
});
