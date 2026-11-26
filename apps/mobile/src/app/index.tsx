import type { Brief, LatLon, PlanResponse, RoadAlert, StopSuggestion, Suggestion } from '@wayboo/core';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapView } from '@/components/map/MapView';
import type { CameraCommand, MapData } from '@/components/map/mapData';
import { NavBanner, NavBottomBar } from '@/components/NavHud';
import { AlertSheet, ArrivalCard, ReportSheet, SuggestionCard } from '@/components/Panels';
import { RouteSheet } from '@/components/RouteSheet';
import { SearchPanel } from '@/components/SearchPanel';
import { Card, IconButton, T } from '@/components/ui';
import { alertsByIds, groupIdsOf, mergeAlerts } from '@/lib/alertGroups';
import { api, ApiError, RegistrationLimitError, type GeocodeResult } from '@/lib/api';
import { checkReportAccuracy } from '@/lib/gpsAccuracy';
import { startLocation, useLocationStore } from '@/lib/location';
import { dismissSession, startNavigation, stopNavigation, toggleMute, useNavSession } from '@/lib/navigation';
import { useSettings } from '@/lib/store';
import { ALERT_LABELS, useTheme } from '@/lib/theme';

const SAO_PAULO: [number, number] = [-46.6333, -23.5505];

export default function MapScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const wide = width >= 900;

  const fix = useLocationStore((s) => s.fix);
  const locError = useLocationStore((s) => s.error);
  const session = useNavSession();
  const avoidTolls = useSettings((s) => s.avoidTolls);
  const avoidHighways = useSettings((s) => s.avoidHighways);

  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [selected, setSelected] = useState(0);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [stops, setStops] = useState<StopSuggestion[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [nearbyAlerts, setNearbyAlerts] = useState<RoadAlert[]>([]);
  /** Ids do grupo do marcador tocado, enquanto a folha de detalhes está aberta. */
  const [selectedAlerts, setSelectedAlerts] = useState<string[] | null>(null);
  /** Respostas de voto. Entram na junção dos alertas, onde vence a cópia com mais votos. */
  const [votedAlerts, setVotedAlerts] = useState<RoadAlert[]>([]);
  /** Alertas que o servidor disse não existirem mais (404 ao votar). */
  const [goneAlerts, setGoneAlerts] = useState<ReadonlySet<string>>(new Set());
  /** Votos a caminho do servidor, com a direção, para o spinner ir no botão tocado. */
  const [voting, setVoting] = useState<ReadonlyMap<string, 'up' | 'down'>>(new Map());
  /** Muda para recarregar os alertas ao redor fora do intervalo de um minuto. */
  const [alertsReload, setAlertsReload] = useState(0);
  const [camera, setCamera] = useState<(CameraCommand & { nonce: number }) | null>(null);
  const [follow, setFollow] = useState(true);
  const nonce = useRef(0);
  const userPicked = useRef(false);
  const lastHeading = useRef(0);
  const mapCenter = useRef<[number, number]>(SAO_PAULO);

  const command = useCallback((c: CameraCommand) => setCamera({ ...c, nonce: ++nonce.current }), []);
  const notify = useCallback((text: string) => {
    setToast(text);
    // iOS e Android não anunciam o toast sozinhos; na web, o `role="alert"` dele já anuncia.
    if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(text);
    setTimeout(() => setToast((cur) => (cur === text ? null : cur)), 4500);
  }, []);
  // Sugestões e alertas falham em silêncio, mas costumam ser as chamadas que registram o aparelho.
  // O 429 do registro aparece uma vez por bloqueio, não a cada recarga dos alertas.
  const shownLimit = useRef(0);
  const backgroundError = useCallback(
    (e: unknown) => {
      if (!(e instanceof RegistrationLimitError) || e.retryAt === shownLimit.current) return;
      shownLimit.current = e.retryAt;
      notify(e.message);
    },
    [notify],
  );

  const here: LatLon | null = fix ? { lat: fix.lat, lon: fix.lon } : null;
  const hereKey = here ? `${here.lat.toFixed(3)},${here.lon.toFixed(3)}` : null;

  useEffect(() => {
    void startLocation();
  }, []);

  const centered = useRef(false);
  useEffect(() => {
    if (fix && !centered.current) {
      centered.current = true;
      mapCenter.current = [fix.lon, fix.lat];
      command({ type: 'center', center: [fix.lon, fix.lat], zoom: 15 });
    }
  }, [fix, command]);

  // Sugestões de rotina (ex.: "indo para o trabalho?") quando o app abre parado num lugar conhecido.
  const lastSuggestion = useRef(0);
  useEffect(() => {
    if (!hereKey || plan || session.status !== 'idle') return;
    if (Date.now() - lastSuggestion.current < 5 * 60_000) return;
    lastSuggestion.current = Date.now();
    const [lat, lon] = hereKey.split(',').map(Number) as [number, number];
    api
      .suggestions({ lat, lon })
      .then((r) => setSuggestions(r.suggestions))
      .catch((e) => {
        setSuggestions([]);
        backgroundError(e);
      });
  }, [hereKey, plan, session.status, backgroundError]);

  // Alertas da comunidade ao redor, atualizados a cada minuto.
  useEffect(() => {
    if (!hereKey) return;
    const [lat, lon] = hereKey.split(',').map(Number) as [number, number];
    const load = () =>
      api
        .alerts({ minLat: lat - 0.06, minLon: lon - 0.06, maxLat: lat + 0.06, maxLon: lon + 0.06 })
        .then((r) => setNearbyAlerts(r.alerts))
        .catch(backgroundError);
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [hereKey, backgroundError, alertsReload]);

  const fitPlan = useCallback(
    (p: PlanResponse) => {
      const coords = p.routes.flatMap((r) => r.route.geometry);
      const lons = coords.map((c) => c[0]);
      const lats = coords.map((c) => c[1]);
      command({
        type: 'fit',
        bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        padding: wide
          ? { top: 80, bottom: 80, left: 470, right: 80 }
          : { top: insets.top + 90, bottom: Math.min(height * 0.55, 470), left: 40, right: 40 },
      });
    },
    [command, wide, insets.top, height],
  );

  const showPlan = useCallback(
    (p: PlanResponse, extra: { stops?: StopSuggestion[]; message?: string | null } = {}) => {
      setPlan(p);
      setSelectedAlerts(null);
      setSelected(p.recommendedIndex);
      setBrief(null);
      setStops(extra.stops ?? []);
      setMessage(extra.message ?? null);
      setSuggestions([]);
      userPicked.current = false;
      fitPlan(p);
      setBriefLoading(true);
      api
        .brief(p.planId)
        .then((b) => {
          setBrief(b);
          if (!userPicked.current) setSelected(b.recommendedIndex);
        })
        .catch(() => setBrief(null))
        .finally(() => setBriefLoading(false));
    },
    [fitPlan],
  );

  const origin = (): LatLon => {
    if (here) return here;
    notify('Sem GPS: usando o centro do mapa como origem.');
    return { lon: mapCenter.current[0], lat: mapCenter.current[1] };
  };

  const planTo = async (destination: LatLon, name?: string) => {
    setBusy(true);
    try {
      const p = await api.plan({
        origin: origin(),
        destination,
        destinationName: name,
        options: { avoidTolls, avoidHighways, avoidFerries: false },
      });
      showPlan(p);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Falha ao planejar');
    } finally {
      setBusy(false);
    }
  };

  const ask = async (text: string) => {
    setBusy(true);
    try {
      const r = await api.assistant(text, origin());
      if (r.plan) showPlan(r.plan, { stops: r.stops, message: r.message });
      else notify(r.message);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Copiloto indisponível');
    } finally {
      setBusy(false);
    }
  };

  const onPick = (r: GeocodeResult) => void planTo({ lat: r.lat, lon: r.lon }, r.name);

  const onLongPress = async (p: LatLon) => {
    if (session.status === 'navigating') return;
    const name = await api
      .reverse(p)
      .then((r) => r.result?.name)
      .catch(() => undefined);
    void planTo(p, name ?? 'Ponto no mapa');
  };

  const closePlan = () => {
    setPlan(null);
    setBrief(null);
    setStops([]);
    setMessage(null);
    if (here) command({ type: 'center', center: [here.lon, here.lat], zoom: 15 });
  };

  const start = (simulate: boolean) => {
    if (!plan) return;
    setFollow(true);
    void startNavigation(plan, selected, simulate);
  };

  // Com a simulação ativa, o ponto do reporte (`session.nav`) não vem do GPS e a precisão não conta.
  // `simulated` sozinho não basta: continua true depois de dispensar a sessão, quando o ponto volta a ser `here`.
  const reportAccuracy = checkReportAccuracy(session.nav && session.simulated ? null : fix?.accuracy);

  const report = async (type: RoadAlert['type']) => {
    setReporting(false);
    const p = session.nav ? { lat: session.nav.snapped[1], lon: session.nav.snapped[0] } : here;
    if (!p) return notify('Sem localização para reportar.');
    if (!reportAccuracy.ok) return notify(reportAccuracy.message);
    try {
      const a = await api.report(type, p);
      setNearbyAlerts((cur) => [a, ...cur.filter((x) => x.id !== a.id)]);
      notify(`${ALERT_LABELS[type]} reportado. Obrigado!`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Falha ao reportar');
    }
  };

  const openReport = () => {
    setSelectedAlerts(null);
    setReporting(true);
  };

  const vote = async (a: RoadAlert, up: boolean) => {
    setVoting((cur) => new Map(cur).set(a.id, up ? 'up' : 'down'));
    try {
      const updated = await api.vote(a.id, up);
      setVotedAlerts((cur) => [...cur.filter((x) => x.id !== updated.id), updated]);
      if (Date.parse(updated.expiresAt) <= Date.now()) notify('Alerta tirado do mapa. Obrigado!');
      else notify(up ? 'Confirmação registrada. Obrigado!' : 'Negação registrada. Obrigado!');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGoneAlerts((cur) => new Set(cur).add(a.id));
      // Já votou (em outro aparelho, ou a lista estava velha) ou é o autor: a lista nova traz o estado certo.
      if (e instanceof ApiError && (e.status === 409 || e.status === 403)) setAlertsReload((n) => n + 1);
      notify(e instanceof Error ? e.message : 'Falha ao votar');
    } finally {
      setVoting((cur) => {
        const next = new Map(cur);
        next.delete(a.id);
        return next;
      });
    }
  };

  // Câmera acompanha o carro durante a navegação, até o usuário arrastar o mapa.
  useEffect(() => {
    if (session.status !== 'navigating' || !follow || !session.nav) return;
    if (fix?.heading != null && (fix.speed ?? 1) > 0.8) lastHeading.current = fix.heading;
    command({ type: 'follow', center: session.nav.snapped, bearing: lastHeading.current, zoom: 16.5, pitch: 55 });
  }, [session.nav, session.status, follow, fix, command]);

  const navigating = session.status === 'navigating';

  const mapData: MapData = useMemo(() => {
    // O plano é uma foto do momento em que foi pedido; os alertas ao redor são recarregados a cada minuto.
    const alerts = (p: PlanResponse | null | undefined) =>
      mergeAlerts([(p?.routes ?? []).flatMap((r) => r.alerts), nearbyAlerts], goneAlerts, Date.now(), votedAlerts);
    if (navigating && session.route) {
      return {
        routes: [{ id: session.route.id, coords: session.route.geometry, selected: true }],
        alerts: alerts(session.plan),
        slowSpots: session.plan?.routes.find((r) => r.route.id === session.route?.id)?.slowSpots ?? [],
        destination: session.plan?.destination ?? null,
        stops: session.stops.filter((x) => !x.visited),
        puck: session.nav ? { lat: session.nav.snapped[1], lon: session.nav.snapped[0], heading: lastHeading.current } : null,
      };
    }
    return {
      routes: plan ? plan.routes.map((r, i) => ({ id: r.route.id, coords: r.route.geometry, selected: i === selected })) : [],
      alerts: alerts(plan),
      slowSpots: plan?.routes[selected]?.slowSpots ?? [],
      destination: plan?.destination ?? null,
      stops,
      puck: here ? { ...here, heading: fix?.heading ?? null, accuracy: fix?.accuracy ?? null } : null,
    };
  }, [navigating, session.route, session.plan, session.stops, session.nav, plan, selected, stops, nearbyAlerts, votedAlerts, goneAlerts, here?.lat, here?.lon, fix?.accuracy]); // eslint-disable-line react-hooks/exhaustive-deps

  const sheetAlerts = useMemo(() => (selectedAlerts ? alertsByIds(mapData.alerts, selectedAlerts) : []), [selectedAlerts, mapData.alerts]);
  // Todos os alertas do ponto saíram do mapa (expiraram ou foram negados): fecha a folha.
  useEffect(() => {
    if (selectedAlerts && sheetAlerts.length === 0) setSelectedAlerts(null);
  }, [selectedAlerts, sheetAlerts.length]);
  const alertSheet =
    sheetAlerts.length > 0 ? (
      <AlertSheet alerts={sheetAlerts} pending={voting} onVote={(a, up) => void vote(a, up)} onClose={() => setSelectedAlerts(null)} />
    ) : null;

  const panelStyle = wide ? [styles.sidePanel, { top: insets.top + 84 }] : [styles.bottomPanel, { paddingBottom: insets.bottom + 10 }];

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <MapView
        theme={t}
        data={mapData}
        camera={camera}
        initialCenter={SAO_PAULO}
        onLongPress={onLongPress}
        onUserPan={() => navigating && setFollow(false)}
        onAlertPress={(id) => {
          // Com o cartão de chegada aberto, a folha ficaria escondida e apareceria sozinha depois.
          if (session.status === 'arrived') return;
          setReporting(false);
          setSelectedAlerts(groupIdsOf(mapData.alerts, id));
        }}
      />

      {navigating ? (
        <>
          <NavBanner nav={session.nav} rerouting={session.rerouting} simulated={session.simulated} />
          {!follow ? (
            <View style={[styles.recenter, { bottom: insets.bottom + 110 }]}>
              <IconButton icon="crosshairs-gps" label="Recentralizar" onPress={() => setFollow(true)} active />
            </View>
          ) : null}
          {reporting ? (
            <View style={panelStyle}>
              <ReportSheet accuracy={reportAccuracy} onReport={report} onClose={() => setReporting(false)} />
            </View>
          ) : alertSheet ? (
            <View style={panelStyle}>{alertSheet}</View>
          ) : (
            <NavBottomBar
              nav={session.nav}
              muted={session.muted}
              onReport={openReport}
              onMute={toggleMute}
              onStop={() => void stopNavigation()}
            />
          )}
        </>
      ) : (
        <>
          <View style={[styles.top, { paddingTop: insets.top + 10 }, wide && { width: 440 }]} pointerEvents="box-none">
            <SearchPanel near={here} onPick={onPick} onAsk={(text) => void ask(text)} busy={busy} />
          </View>

          <View style={[styles.fabs, { top: insets.top + 84 }]} pointerEvents="box-none">
            <IconButton icon="brain" label="Aprendizado" onPress={() => router.push('/insights')} color={t.learn} />
            <IconButton icon="cog-outline" label="Ajustes" onPress={() => router.push('/settings')} />
            <IconButton
              icon="crosshairs-gps"
              label="Minha localização"
              onPress={() => (here ? command({ type: 'center', center: [here.lon, here.lat], zoom: 15 }) : void startLocation())}
            />
            <IconButton icon="alert-plus" label="Reportar" onPress={openReport} color={t.warning} />
          </View>

          <View style={panelStyle} pointerEvents="box-none">
            {session.status === 'arrived' ? (
              <ArrivalCard
                result={session.result}
                onClose={() => {
                  dismissSession();
                  closePlan();
                }}
              />
            ) : reporting ? (
              <ReportSheet accuracy={reportAccuracy} onReport={report} onClose={() => setReporting(false)} />
            ) : alertSheet ? (
              alertSheet
            ) : plan ? (
              <RouteSheet
                plan={plan}
                selected={selected}
                onSelect={(i) => {
                  userPicked.current = true;
                  setSelected(i);
                }}
                brief={brief}
                briefLoading={briefLoading}
                stops={stops}
                message={message}
                onStart={start}
                onClose={closePlan}
              />
            ) : (
              <ScrollView style={{ maxHeight: height * 0.4 }} contentContainerStyle={{ gap: 10 }} pointerEvents="box-none">
                {locError ? (
                  <Card>
                    <T variant="caption" color={t.warning}>
                      {locError}
                    </T>
                  </Card>
                ) : null}
                {suggestions.map((s) => (
                  <SuggestionCard key={s.place.id} s={s} onGo={() => showPlan(s.plan)} />
                ))}
              </ScrollView>
            )}
          </View>
        </>
      )}

      {toast ? (
        <View role="alert" style={[styles.toast, { top: insets.top + (navigating ? 150 : 80) }]} pointerEvents="none">
          <Card style={{ paddingVertical: 10 }}>
            <T variant="caption" color={t.text}>
              {toast}
            </T>
          </Card>
        </View>
      ) : null}
      {session.error && navigating ? (
        <View style={[styles.toast, { top: insets.top + 200 }]} pointerEvents="none">
          <Card style={{ paddingVertical: 10 }}>
            <T variant="caption" color={t.warning}>
              {session.error}
            </T>
          </Card>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, zIndex: 10 },
  fabs: { position: 'absolute', right: 12, gap: 10 },
  bottomPanel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  sidePanel: { position: 'absolute', left: 12, width: 440, maxHeight: '85%' },
  recenter: { position: 'absolute', right: 16 },
  toast: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
});
