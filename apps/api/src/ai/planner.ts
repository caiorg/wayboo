import {
  formatDurationPtBR,
  IntentSchema,
  STOP_CATEGORIES,
  type Brief,
  type Insights,
  type Intent,
  type PlanResponse,
  type StopCategory,
} from '@wayboo/core';
import { z } from 'zod';
import { tryLlm, type LlmProvider } from './providers';

type Log = (msg: string) => void;
/** Provedor com a chave do usuário; omitido, vale o do servidor. */
type Ai = LlmProvider | undefined;

// ---------- interpretação do pedido ----------

const INTENT_SYSTEM = `Você interpreta pedidos de navegação de motoristas brasileiros e devolve JSON.
Regras:
- destinationQuery: o lugar a buscar no mapa (endereço, estabelecimento, bairro), sem verbos nem condições. null se o destino for casa ou trabalho.
- destinationPlace: "home" para casa, "work" para trabalho/escritório/serviço; senão null.
- avoidTolls/avoidHighways/avoidFerries: true só se o usuário pedir explicitamente.
- stops: paradas no caminho (ex.: "passando num posto" → fuel). query só se citar marca ou nome.
- arriveBy/departAt: horário local "HH:MM" se mencionado; senão null.
- priority: fastest, reliable (previsível, sem surpresas), familiar (caminho de sempre), shortest; null se não houver.
Não invente informação que não está no texto.`;

const STOP_PATTERNS: [RegExp, StopCategory][] = [
  [/\b(posto|gasolina|abastecer|combust[ií]vel|etanol)\b/, 'fuel'],
  [/\b(caf[eé]|cafeteria|padaria)\b/, 'coffee'],
  [/\b(farm[aá]cia|drogaria)\b/, 'pharmacy'],
  [/\b(restaurante|almo[cç]\w*|jantar|comer|lanch\w*)\b/, 'food'],
  [/\b(estacionamento|estacionar)\b/, 'parking'],
  [/\b(eletroposto|carregador|carregar o carro)\b/, 'ev_charging'],
  [/\b(caixa eletr[oô]nico|sacar|banco 24)\b/, 'atm'],
  [/\b(supermercado|mercado)\b/, 'supermarket'],
];

const hhmm = (h?: string, m?: string) => (h ? `${h.padStart(2, '0')}:${(m ?? '00').padStart(2, '0')}` : null);

/** Interpretação por regras (pt-BR), usada sem IA ou quando ela falha. */
export function heuristicIntent(raw: string): Intent {
  const text = raw.toLowerCase().normalize('NFC');
  const arrive = /chegar\s+(?:at[eé]|[àa]s?|antes d[ae]s?)\s*(\d{1,2})(?:\s*[:h]\s*(\d{2}))?/.exec(text);
  const depart = /sa(?:ir|indo)\s+(?:[àa]s?)\s*(\d{1,2})(?:\s*[:h]\s*(\d{2}))?/.exec(text);
  const home = /\b(?:pra|para|pro|at[eé]|em)\s+(?:a\s+)?casa\b|\bvoltar pra casa\b/.test(text);
  const work = /\b(trabalho|escrit[oó]rio|servi[cç]o|firma)\b/.test(text);
  let query: string | null = null;
  if (!home && !work) {
    const m = /\b(?:para|pra|pro|at[eé]|ao|à|ir\s+(?:no|na|ao|à|para|pra))\s+(?:o\s+|a\s+)?(.+)$/.exec(raw.trim());
    query = (m?.[1] ?? raw)
      .split(/\s*(?:,|\bsem\b|\bevitando\b|\bpassando\b|\bparando\b|\be\s+(?:chegar|sair|passar|parar)\b|\bchegando\b|\bsaindo\b|\bpelo caminho\b)\s*/i)[0]!
      .trim();
    if (!query) query = null;
  }
  return {
    destinationQuery: query,
    destinationPlace: home ? 'home' : work ? 'work' : null,
    avoidTolls: /(sem|evit\w*|fugir d[eo]s?)\s+(?:o\s+|os\s+)?ped[aá]gios?/.test(text),
    avoidHighways: /(sem|evit\w*)\s+(?:a\s+|as\s+)?(rodovias?|estradas?|marginal|marginais)/.test(text),
    avoidFerries: /(sem|evit\w*)\s+(?:a\s+)?balsas?/.test(text),
    stops: STOP_PATTERNS.filter(([re]) => re.test(text)).map(([, category]) => ({ category, query: null })),
    arriveBy: hhmm(arrive?.[1], arrive?.[2]),
    departAt: hhmm(depart?.[1], depart?.[2]),
    priority: /mais r[aá]pid/.test(text)
      ? 'fastest'
      : /previs[ií]vel|confi[aá]vel|sem surpresa/.test(text)
        ? 'reliable'
        : /caminho de sempre|conhecid/.test(text)
          ? 'familiar'
          : /mais curt/.test(text)
            ? 'shortest'
            : null,
  };
}

export async function parseIntent(text: string, log: Log, provider?: Ai): Promise<{ intent: Intent; provider: string }> {
  const ai = await tryLlm(
    (p) => p.generateObject({ system: INTENT_SYSTEM, prompt: text, schema: IntentSchema, schemaName: 'navigation_intent' }),
    log,
    provider,
  );
  if (ai) {
    const stops = ai.stops.filter((s) => (STOP_CATEGORIES as readonly string[]).includes(s.category));
    return { intent: { ...ai, stops }, provider: 'ia' };
  }
  return { intent: heuristicIntent(text), provider: 'regras' };
}

// ---------- briefing da rota ----------

const BRIEF_SYSTEM = `Você é o copiloto de um app de navegação. Recebe rotas candidatas com ETA base do roteador
e ETA aprendido com o histórico do motorista (trânsito típico por trecho e horário, efeito do clima, rotina),
mais alertas da comunidade, pontos de lentidão recorrentes e as preferências aprendidas.
Escolha a melhor rota para ESTE motorista e explique em português do Brasil.
Regras:
- Use somente os dados fornecidos. Não invente acidentes, obras ou números.
- Prefira o ETA aprendido ao ETA base quando a confiança for média ou alta, e diga isso quando mudar a escolha.
- recommendedIndex: índice da rota escolhida. Em geral é a recomendação do modelo; troque só com motivo claro nos dados.
- headline: até 70 caracteres, direto (ex.: "Vá pela Marginal: 24 min, 6 a menos que pela Rebouças").
- explanation: no máximo 2 frases curtas com o porquê.
- warnings: só riscos concretos presentes nos dados (alertas, chuva, lentidão recorrente). Lista vazia se nada.
- departureAdvice: só se sair em outro horário economizar 3 min ou mais, ou se houver horário de chegada; senão null.`;

const BriefAiSchema = z.object({
  recommendedIndex: z.number(),
  headline: z.string(),
  explanation: z.string(),
  warnings: z.array(z.string()),
  departureAdvice: z.string().nullable(),
});

const hm = (epoch: number, timeZone: string) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(epoch));

function briefPayload(plan: PlanResponse, timeZone: string, tradeoffs: string[]) {
  return {
    destino: plan.destinationPlace?.label ?? plan.destinationName,
    saida: hm(plan.departAt, timeZone),
    nivelAprendizado: plan.learningLevel,
    clima: plan.context.weather?.description ?? 'desconhecido',
    recomendacaoDoModelo: plan.recommendedIndex,
    motivoDoModelo: plan.reason,
    preferenciasAprendidas: tradeoffs,
    rotas: plan.routes.map((r, i) => ({
      indice: i,
      via: r.route.maneuvers
        .filter((m) => m.distanceM > 800 && m.streetNames[0])
        .sort((a, b) => b.distanceM - a.distanceM)
        .slice(0, 2)
        .map((m) => m.streetNames[0]),
      etaAprendidoMin: Math.round(r.eta.durationS / 60),
      faixaMin: [Math.round(r.eta.p10S / 60), Math.round(r.eta.p90S / 60)],
      etaBaseMin: Math.round(r.eta.baseDurationS / 60),
      confianca: Number(r.eta.confidence.toFixed(2)),
      fatores: r.eta.factors.map((f) => `${f.label}: ${Math.round(f.deltaS / 60)} min`),
      km: Number((r.route.distanceM / 1000).toFixed(1)),
      pedagio: r.route.hasToll,
      fracaoRodovia: Number(r.route.highwayShare.toFixed(2)),
      familiaridade: Number(r.familiarity.toFixed(2)),
      alertas: r.alerts.map((a) => a.type),
      lentidaoRecorrente: r.slowSpots.map((s) => `${s.when}: ${s.factor.toFixed(1)}x mais lento`),
      probabilidadeDeEscolha: Number(r.probability.toFixed(2)),
      tags: r.tags,
    })),
    opcoesDeSaida: plan.departures.map((d) => ({ saida: hm(d.departAt, timeZone), etaMin: Math.round(d.durationS / 60) })),
  };
}

export function heuristicBrief(plan: PlanResponse, timeZone: string): Brief {
  const best = plan.routes[plan.recommendedIndex]!;
  const fastest = Math.min(...plan.routes.map((r) => r.eta.durationS));
  const warnings: string[] = [];
  const alertCount = best.alerts.length;
  if (alertCount) warnings.push(`${alertCount} alerta(s) da comunidade nesta rota`);
  if (plan.context.rain) warnings.push(`${plan.context.weather?.description ?? 'Chuva'}: dirija com cautela`);
  for (const s of best.slowSpots.slice(0, 2)) warnings.push(`Lentidão recorrente (${s.when}), ${s.factor.toFixed(1)}x o normal`);
  const now = plan.departures[0];
  const better = plan.departures.reduce((a, b) => (b.durationS < a.durationS ? b : a), now ?? { departAt: 0, durationS: Infinity, p90S: 0 });
  const saves = now ? (now.durationS - better.durationS) / 60 : 0;
  return {
    recommendedIndex: plan.recommendedIndex,
    headline: `${formatDurationPtBR(best.eta.durationS)} (entre ${formatDurationPtBR(best.eta.p10S)} e ${formatDurationPtBR(best.eta.p90S)})`,
    explanation:
      best.eta.durationS > fastest + 60
        ? `${plan.reason} Ela leva ${formatDurationPtBR(best.eta.durationS - fastest)} a mais que a mais rápida.`
        : plan.reason,
    warnings,
    departureAdvice: saves >= 3 ? `Saindo às ${hm(better.departAt, timeZone)} você economiza ~${Math.round(saves)} min.` : null,
    provider: 'regras',
    model: null,
  };
}

export async function briefPlan(plan: PlanResponse, timeZone: string, tradeoffs: string[], log: Log, provider?: Ai): Promise<Brief> {
  const payload = briefPayload(plan, timeZone, tradeoffs);
  const ai = await tryLlm(async (p) => {
    const out = await p.generateObject({
      system: BRIEF_SYSTEM,
      prompt: JSON.stringify(payload),
      schema: BriefAiSchema,
      schemaName: 'route_brief',
    });
    return { ...out, provider: p.name, model: p.model };
  }, log, provider);
  if (!ai) return heuristicBrief(plan, timeZone);
  const idx = Number.isInteger(ai.recommendedIndex) && ai.recommendedIndex >= 0 && ai.recommendedIndex < plan.routes.length;
  return { ...ai, recommendedIndex: idx ? ai.recommendedIndex : plan.recommendedIndex };
}

// ---------- narrativa do que foi aprendido ----------

const NARRATIVE_SYSTEM = `Você resume, em português do Brasil, o que um app de navegação aprendeu sobre um motorista.
Use só os dados fornecidos. Até 5 frases curtas, cada uma com um fato concreto e útil
(ex.: horário com mais trânsito, quanto o ETA melhorou, preferência aprendida). Sem floreios.`;

export async function narrateInsights(insights: Insights, log: Log, provider?: Ai): Promise<{ text: string; provider: string } | null> {
  const ai = await tryLlm(
    (p) =>
      p.generateObject({
        system: NARRATIVE_SYSTEM,
        prompt: JSON.stringify({
          viagens: insights.trips,
          km: Math.round(insights.kmDriven),
          lugares: insights.places.map((p) => `${p.label} (${p.visits} visitas)`),
          rotinas: insights.routines,
          // Só os campos que a narrativa usa: coordenadas, ids e instantes não vão ao provedor.
          precisao: insights.accuracy.slice(-10).map((a) => ({ errorBasePct: a.errorBasePct, errorLearnedPct: a.errorLearnedPct })),
          preferencias: insights.tradeoffs.map((t) => t.label),
          lentidao: insights.slowSpots.slice(0, 5).map((s) => ({ factor: s.factor, observations: s.observations, when: s.when })),
          contexto: insights.contextFactors,
        }),
        schema: z.object({ text: z.string() }),
        schemaName: 'insights_summary',
      }),
    log,
    provider,
  );
  return ai ? { text: ai.text, provider: 'ia' } : null;
}
