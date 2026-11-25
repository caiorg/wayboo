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
import { api } from './api';
import { BACKGROUND_LOCATION_SUPPORTED, startBackgroundLocation, stopBackgroundLocation } from './backgroundLocation';
import { useLocationStore } from './location';
import { useSettings } from './store';

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
/** Limite de `SamplesSchema` na API. */
const MAX_SAMPLES_PER_POST = 2000;
const BACKGROUND_UNAVAILABLE = 'Com a tela bloqueada, a navegação pausa neste aparelho.';

let navigator: Navigator | null = null;
let unsubscribe: (() => void) | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
/** Rastro de uma viagem. Cada navegação tem o seu: um envio atrasado de outra viagem não mistura amostras. */
interface Trace {
  tripId: string | null;
  samples: TraceSample[];
  sending: Promise<void> | null;
  lastSentAt: number;
}

const newTrace = (): Trace => ({ tripId: null, samples: [], sending: null, lastSentAt: Date.now() });
let trace = newTrace();
let lastRerouteAt = 0;
let finishing = false;
/** Sobe a cada início e fim: uma resposta assíncrona de uma navegação que já acabou é descartada. */
let sessionGen = 0;
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

/** Um envio por vez em cada viagem. Quem chama durante um envio espera o mesmo, que segue até o rastro esvaziar. */
function flush(t: Trace = trace): Promise<void> {
  t.sending ??= send(t).finally(() => {
    t.sending = null;
  });
  return t.sending;
}

async function send(t: Trace) {
  t.lastSentAt = Date.now();
  while (t.tripId && t.samples.length > 0) {
    const batch = t.samples.slice(0, MAX_SAMPLES_PER_POST);
    t.samples = t.samples.slice(batch.length);
    try {
      await api.samples(t.tripId, batch);
    } catch {
      // Sem rede: devolve ao buffer para a próxima tentativa (limite para não crescer sem fim).
      t.samples = [...batch, ...t.samples].slice(-5000);
      return;
    }
  }
}

function cleanup() {
  sessionGen++;
  void stopBackgroundLocation();
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
    navigator = createNavigator(chosen.route, { segmentDurationsS: chosen.eta.segmentDurationsS });
    if (s.tripId) await api.reroute(s.tripId, next.planId, next.recommendedIndex);
    useNavSession.setState({ route: chosen.route, plan: { ...next, destination: s.plan.destination }, rerouting: false });
  } catch (e) {
    useNavSession.setState({ rerouting: false, error: e instanceof Error ? e.message : 'Falha ao recalcular' });
  }
}

function onFix(fix: NavFix) {
  if (!navigator || finishing) return;
  const st = navigator.update(fix);
  const s = useNavSession.getState();
  const stops = markVisitedStops(s.stops, fix, { alongM: st.alongM, project: navigator.project, lastWithin: navigator.lastWithin });
  useNavSession.setState(stops === s.stops ? { nav: st } : { nav: st, stops });
  if (st.announcement) speak(st.announcement);
  if (!s.simulated) {
    trace.samples.push({ t: fix.t, lat: fix.lat, lon: fix.lon, speed: fix.speed ?? null, heading: fix.heading ?? null, accuracy: fix.accuracy ?? null });
    // O Android pausa os timers do JS com o app em segundo plano; os fixes da task continuam chegando.
    if (Date.now() - trace.lastSentAt >= FLUSH_EVERY_MS) void flush();
  }
  if (st.arrived) {
    void stopNavigation();
    return;
  }
  if (st.offRoute && !s.rerouting && Date.now() - lastRerouteAt > 12_000) void reroute(fix);
}

export async function startNavigation(plan: PlanResponse, routeIndex: number, simulate: boolean): Promise<void> {
  cleanup();
  finishing = false;
  const t = (trace = newTrace());
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
  const gen = sessionGen;

  if (simulate) {
    // Simulação não grava viagem: o tempo é acelerado e ensinaria durações falsas ao modelo.
    const drive = simulateDrive(chosen.route, chosen.eta.segmentDurationsS, Date.now(), 1, 3);
    simTimer = setInterval(() => {
      const next = drive.next();
      if (next.done) {
        void stopNavigation();
        return;
      }
      useLocationStore.setState({ fix: next.value });
      onFix(next.value);
    }, 1000 / SIM_SPEEDUP);
    return;
  }

  // Inicia já, com o app na tela: o Android recusa o serviço em primeiro plano depois que o app sai dela.
  if (BACKGROUND_LOCATION_SUPPORTED && useSettings.getState().backgroundNav) {
    void startBackgroundLocation(plan.destinationName).then((ok) => {
      if (!ok && gen === sessionGen && !useNavSession.getState().error) useNavSession.setState({ error: BACKGROUND_UNAVAILABLE });
    });
  }

  try {
    const { tripId } = await api.startTrip(plan.planId, routeIndex);
    t.tripId = tripId;
    useNavSession.setState({ tripId });
  } catch (e) {
    // Sem servidor a navegação continua; só não haverá aprendizado desta viagem.
    useNavSession.setState({ error: e instanceof Error ? e.message : 'Viagem não registrada' });
  }
  t.lastSentAt = Date.now();
  flushTimer = setInterval(() => void flush(t), FLUSH_EVERY_MS);
  unsubscribe = useLocationStore.subscribe((state, prev) => {
    if (state.fix && state.fix !== prev.fix) onFix(state.fix);
  });
  const current = useLocationStore.getState().fix;
  if (current) onFix(current);
}

export async function stopNavigation(): Promise<void> {
  if (finishing) return;
  finishing = true;
  const { tripId, simulated, nav } = useNavSession.getState();
  const t = trace;
  cleanup();
  if (simulated || !tripId) {
    useNavSession.setState({ status: nav?.arrived ? 'arrived' : 'idle', result: null });
    return;
  }
  await flush(t);
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
