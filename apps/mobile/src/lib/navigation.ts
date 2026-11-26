import {
  createNavigator,
  INSTRUCTION_LANGUAGE,
  markVisitedStops,
  rerouteRequest,
  simulateDrive,
  type FinishTripResponse,
  type NavFix,
  type NavState,
  type Navigator,
  type PlanResponse,
  type Route,
  type TraceSample,
  type TripStop,
} from '@wayboo/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import { create } from 'zustand';
import { clearActiveTrip, loadActiveTrip, saveActiveTrip } from './activeTrip';
import { api, ApiError } from './api';
import { useLocationStore } from './location';
import { normalizeApiUrl, useSettings } from './store';

type Status = 'idle' | 'navigating' | 'arrived';

interface NavSession {
  status: Status;
  plan: PlanResponse | null;
  route: Route | null;
  /** Paradas do plano original; as visitadas não voltam nos recálculos. */
  stops: TripStop[];
  nav: NavState | null;
  tripId: string | null;
  simulated: boolean;
  rerouting: boolean;
  muted: boolean;
  result: FinishTripResponse | null;
  error: string | null;
}

export const useNavSession = create<NavSession>(() => ({
  status: 'idle',
  plan: null,
  route: null,
  stops: [],
  nav: null,
  tripId: null,
  simulated: false,
  rerouting: false,
  muted: false,
  result: null,
  error: null,
}));

const KEEP_AWAKE_TAG = 'wayboo-nav';
const SIM_SPEEDUP = 6;
const FLUSH_EVERY_MS = 15_000;

let navigator: Navigator | null = null;
let unsubscribe: (() => void) | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let buffer: TraceSample[] = [];
/** Lote enviado ao servidor e ainda sem resposta: entra na gravação até a confirmação. */
let inFlight: TraceSample[] = [];
let lastRerouteAt = 0;
let finishing = false;
let keepAwakeActive = false;
let keepAwakeQueue: Promise<void> = Promise.resolve();

/**
 * Serializa ativar e desativar o wake lock: parar antes de a ativação terminar não deixa a tela presa acesa.
 * Falhas são ignoradas (web sem a API, HTTP fora de localhost, aba oculta): a navegação segue e só a tela pode apagar.
 */
function queueKeepAwake(op: () => Promise<void>) {
  keepAwakeQueue = keepAwakeQueue.then(op).catch(() => {});
}

function acquireKeepAwake() {
  queueKeepAwake(async () => {
    if (keepAwakeActive) return;
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    keepAwakeActive = true;
  });
}

function releaseKeepAwake() {
  queueKeepAwake(async () => {
    // Na web, desativar uma tag que não está ativa lança ERR_KEEP_AWAKE_TAG_INVALID.
    if (!keepAwakeActive) return;
    // Só marca inativo após sucesso: se falhar, a próxima liberação tenta de novo.
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    keepAwakeActive = false;
  });
}

/**
 * Vozes de efeito e sintetizadores antigos da Apple. O Chrome e o Safari as listam antes das naturais
 * (Eddy e Grandpa antes de Luciana em pt-BR).
 */
const NOVELTY_VOICES = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Eddy', 'Flo', 'Fred', 'Good News', 'Grandma',
  'Grandpa', 'Jester', 'Junior', 'Kathy', 'Organ', 'Ralph', 'Reed', 'Rocko', 'Sandy', 'Shelley', 'Superstar',
  'Trinoids', 'Whisper', 'Wobble', 'Zarvox',
]);

export type VoiceInfo = Pick<Speech.Voice, 'identifier' | 'name' | 'language' | 'quality'> &
  Partial<Pick<Speech.WebVoice, 'isDefault' | 'localService'>>;

const languageTag = (language: string) => language.replace(/_/g, '-').toLowerCase();

function isNovelty(v: VoiceInfo): boolean {
  // iOS: com.apple.eloquence.pt-BR.Eddy, com.apple.speech.synthesis.voice.Bubbles. Web: "Eddy (Portuguese (Brazil))".
  return /eloquence|speech\.synthesis\.voice/i.test(v.identifier) || NOVELTY_VOICES.has(v.name.split(' (')[0]!);
}

/**
 * Melhor voz para falar um texto em `language`, seja qual for o idioma do aparelho. Ordem: mesmo idioma e região
 * (pt-BR), mesmo idioma de outra região (pt-PT), voz natural, qualidade Enhanced, voz padrão do sistema, voz local.
 * Empate fica com a primeira da lista. Nenhuma voz no idioma: null, e a fala usa só `language`.
 */
export function pickVoice(voices: VoiceInfo[], language: string): VoiceInfo | null {
  const want = languageTag(language);
  const base = want.split('-')[0];
  let best: VoiceInfo | null = null;
  let bestScore = 0;
  for (const v of voices) {
    const tag = languageTag(v.language);
    const lang = tag === want ? 2 : tag.split('-')[0] === base ? 1 : 0;
    if (lang === 0) continue;
    const score =
      lang * 16 +
      (isNovelty(v) ? 0 : 8) +
      (v.quality === Speech.VoiceQuality.Enhanced ? 4 : 0) +
      (v.isDefault ? 2 : 0) +
      (v.localService === false ? 0 : 1);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

const VOICES_TIMEOUT_MS = 2000;
const voiceByLanguage = new Map<string, Promise<string | null>>();

/**
 * Identificador da voz para `language`, resolvido uma vez por navegação. Na web, a lista de vozes pode demorar ou
 * nunca chegar: depois de VOICES_TIMEOUT_MS, a fala segue só com `language`.
 */
function voiceFor(language: string): Promise<string | null> {
  const cached = voiceByLanguage.get(language);
  if (cached) return cached;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Speech.Voice[]>((resolve) => {
    timer = setTimeout(() => resolve([]), VOICES_TIMEOUT_MS);
  });
  const found = Promise.race([Speech.getAvailableVoicesAsync(), timeout])
    .catch(() => [] as Speech.Voice[])
    .then((voices) => {
      clearTimeout(timer);
      return pickVoice(voices, language)?.identifier ?? null;
    });
  voiceByLanguage.set(language, found);
  return found;
}

/** Sobe a cada fala, no fim da navegação e ao ativar o mudo: uma fala que ainda espera a voz e ficou velha é descartada. */
let speechGen = 0;

const canSpeak = () => useSettings.getState().voice && !useNavSession.getState().muted;

function speak(text: string) {
  if (!canSpeak()) return;
  const gen = ++speechGen;
  void voiceFor(INSTRUCTION_LANGUAGE).then((id) => {
    if (gen !== speechGen || !canSpeak()) return;
    Speech.stop();
    Speech.speak(text, { language: INSTRUCTION_LANGUAGE, voice: id ?? undefined, rate: 1.02 });
  });
}

const currentApiUrl = () => normalizeApiUrl(useSettings.getState().apiUrl);

/**
 * Grava a navegação real em curso para retomá-la se o app fechar. A simulação não é gravada.
 * Só a rota seguida entra no plano gravado, e o rastro só quando há viagem no servidor para recebê-lo.
 */
function persistTrip() {
  const s = useNavSession.getState();
  if (s.status !== 'navigating' || s.simulated || finishing || !s.plan || !s.route) return;
  const routeId = s.route.id;
  const chosen = s.plan.routes.find((r) => r.route.id === routeId);
  if (!chosen) return;
  void saveActiveTrip({
    savedAt: Date.now(),
    apiUrl: currentApiUrl(),
    plan: { ...s.plan, routes: [chosen], recommendedIndex: 0 },
    routeIndex: 0,
    stops: s.stops,
    tripId: s.tripId,
    // Se o app fechar no meio do envio, a retomada reenvia o lote. Duplicatas têm o mesmo `t` e não mudam a análise.
    buffer: s.tripId ? [...inFlight, ...buffer] : [],
  });
}

let flushChain: Promise<void> = Promise.resolve();

/**
 * Envia o rastro pendente. Um envio por vez: um tique que chega com o anterior ainda sem resposta espera na fila,
 * e `inFlight` guarda sempre o único lote em voo.
 */
function flush(): Promise<void> {
  flushChain = flushChain.then(sendBuffer);
  return flushChain;
}

async function sendBuffer() {
  const { tripId } = useNavSession.getState();
  if (!tripId || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  inFlight = batch;
  try {
    await api.samples(tripId, batch);
  } catch {
    // Sem rede: devolve ao buffer para a próxima tentativa (limite para não crescer sem fim).
    buffer = [...batch, ...buffer].slice(-5000);
  } finally {
    inFlight = [];
  }
}

function cleanup() {
  unsubscribe?.();
  unsubscribe = null;
  if (simTimer) clearInterval(simTimer);
  if (flushTimer) clearInterval(flushTimer);
  simTimer = null;
  flushTimer = null;
  navigator = null;
  speechGen++;
  Speech.stop();
  releaseKeepAwake();
}

async function reroute(fix: NavFix) {
  const s = useNavSession.getState();
  if (!s.plan || s.rerouting) return;
  lastRerouteAt = Date.now();
  useNavSession.setState({ rerouting: true });
  speak('Recalculando rota');
  try {
    const { avoidTolls, avoidHighways } = useSettings.getState();
    const next = await api.plan(rerouteRequest(s.plan, fix, s.stops, { avoidTolls, avoidHighways, avoidFerries: false }));
    const chosen = next.routes[next.recommendedIndex]!;
    if (s.tripId) await api.reroute(s.tripId, next.planId, next.recommendedIndex);
    // Encerrada durante o recálculo: não ressuscita o navegador.
    if (finishing || useNavSession.getState().status !== 'navigating') return;
    // Só depois do registro: se ele falhar, navegador, rota e plano continuam todos na rota anterior.
    navigator = createNavigator(chosen.route, { segmentDurationsS: chosen.eta.segmentDurationsS });
    useNavSession.setState({ route: chosen.route, plan: { ...next, destination: s.plan.destination }, rerouting: false, error: null });
    persistTrip();
  } catch (e) {
    // Sem rede o navegador antigo continua valendo: a orientação segue pela rota já calculada.
    const error = e instanceof ApiError && e.status === 0 ? 'Sem conexão: seguindo a rota anterior.' : e instanceof Error ? e.message : 'Falha ao recalcular';
    useNavSession.setState({ rerouting: false, error });
  }
}

function onFix(fix: NavFix) {
  if (!navigator || finishing) return;
  const st = navigator.update(fix);
  const s = useNavSession.getState();
  const stops = markVisitedStops(s.stops, fix, { alongM: st.alongM, project: navigator.project, lastWithin: navigator.lastWithin });
  useNavSession.setState(stops === s.stops ? { nav: st } : { nav: st, stops });
  if (st.announcement) speak(st.announcement);
  if (!s.simulated) buffer.push({ t: fix.t, lat: fix.lat, lon: fix.lon, speed: fix.speed ?? null, heading: fix.heading ?? null, accuracy: fix.accuracy ?? null });
  if (stops !== s.stops) persistTrip();
  if (st.arrived) {
    void stopNavigation();
    return;
  }
  if (st.offRoute && !s.rerouting && Date.now() - lastRerouteAt > 12_000) void reroute(fix);
}

export async function startNavigation(plan: PlanResponse, routeIndex: number, simulate: boolean): Promise<void> {
  cleanup();
  finishing = false;
  buffer = [];
  inFlight = [];
  // O intervalo entre recálculos é por navegação: um recálculo da anterior não atrasa o desta.
  lastRerouteAt = 0;
  const chosen = plan.routes[routeIndex];
  if (!chosen) return;
  // Vozes podem ter sido instaladas desde a última navegação; já começa a buscar para a primeira fala.
  voiceByLanguage.clear();
  void voiceFor(INSTRUCTION_LANGUAGE);
  navigator = createNavigator(chosen.route, { segmentDurationsS: chosen.eta.segmentDurationsS });
  useNavSession.setState({
    status: 'navigating',
    plan,
    route: chosen.route,
    stops: plan.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, visited: false })),
    nav: null,
    tripId: null,
    simulated: simulate,
    rerouting: false,
    result: null,
    error: null,
  });
  acquireKeepAwake();

  if (simulate) {
    // Simulação não grava viagem: o tempo é acelerado e ensinaria durações falsas ao modelo.
    const gen = simulateDrive(chosen.route, chosen.eta.segmentDurationsS, Date.now(), 1, 3);
    simTimer = setInterval(() => {
      const next = gen.next();
      if (next.done) {
        void stopNavigation();
        return;
      }
      useLocationStore.setState({ fix: next.value });
      onFix(next.value);
    }, 1000 / SIM_SPEEDUP);
    return;
  }

  persistTrip();
  try {
    const { tripId } = await api.startTrip(plan.planId, routeIndex);
    useNavSession.setState({ tripId });
    persistTrip();
  } catch (e) {
    // Sem servidor a navegação continua; só não haverá aprendizado desta viagem.
    useNavSession.setState({ error: e instanceof Error ? e.message : 'Viagem não registrada' });
  }
  followLocation();
}

/** Liga a navegação real ao GPS e ao envio periódico do rastro. */
function followLocation() {
  flushTimer = setInterval(() => {
    void flush().then(persistTrip);
  }, FLUSH_EVERY_MS);
  unsubscribe = useLocationStore.subscribe((state, prev) => {
    if (state.fix && state.fix !== prev.fix) onFix(state.fix);
  });
  const current = useLocationStore.getState().fix;
  if (current) onFix(current);
}

/**
 * Retoma a navegação gravada quando o app reabre (o sistema pode tê-lo fechado no meio da viagem, com ou sem rede).
 * Não chama o servidor: a rota, as paradas visitadas e o rastro pendente vêm do aparelho.
 */
export async function resumeNavigation(): Promise<boolean> {
  if (useNavSession.getState().status !== 'idle') return false;
  const trip = await loadActiveTrip(currentApiUrl());
  if (!trip || useNavSession.getState().status !== 'idle') return false;
  const chosen = trip.plan.routes[trip.routeIndex]!;
  cleanup();
  finishing = false;
  buffer = trip.buffer;
  inFlight = [];
  lastRerouteAt = 0;
  voiceByLanguage.clear();
  void voiceFor(INSTRUCTION_LANGUAGE);
  navigator = createNavigator(chosen.route, { segmentDurationsS: chosen.eta.segmentDurationsS });
  useNavSession.setState({
    status: 'navigating',
    plan: trip.plan,
    route: chosen.route,
    stops: trip.stops,
    nav: null,
    tripId: trip.tripId,
    simulated: false,
    rerouting: false,
    result: null,
    error: null,
  });
  acquireKeepAwake();
  followLocation();
  return true;
}

export async function stopNavigation(): Promise<void> {
  if (finishing) return;
  finishing = true;
  const { tripId, simulated, nav } = useNavSession.getState();
  cleanup();
  void clearActiveTrip();
  if (simulated || !tripId) {
    useNavSession.setState({ status: nav?.arrived ? 'arrived' : 'idle', result: null });
    return;
  }
  await flush();
  try {
    const result = await api.finishTrip(tripId);
    useNavSession.setState({ status: 'arrived', result });
  } catch (e) {
    useNavSession.setState({ status: 'idle', error: e instanceof Error ? e.message : 'Falha ao encerrar viagem' });
  }
}

export function toggleMute() {
  const muted = !useNavSession.getState().muted;
  if (muted) {
    speechGen++;
    Speech.stop();
  }
  useNavSession.setState({ muted });
}

export function dismissSession() {
  useNavSession.setState({ status: 'idle', plan: null, route: null, stops: [], nav: null, tripId: null, result: null, error: null });
}
