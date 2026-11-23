import type { Maneuver } from './types';

/**
 * Idioma (BCP 47) das instruções de navegação: os verbos abaixo, o texto que o Valhalla devolve e as frases que o
 * app fala. A voz do app segue este valor, não o idioma do aparelho.
 */
export const INSTRUCTION_LANGUAGE = 'pt-BR';

/** Verbos em pt-BR por tipo de manobra do Valhalla. */
const VERB: Record<number, string> = {
  1: 'Siga',
  2: 'Siga',
  3: 'Siga',
  4: 'Você chegou ao destino',
  5: 'Destino à direita',
  6: 'Destino à esquerda',
  7: 'Continue',
  8: 'Continue',
  9: 'Mantenha-se levemente à direita',
  10: 'Vire à direita',
  11: 'Vire acentuadamente à direita',
  12: 'Faça o retorno',
  13: 'Faça o retorno',
  14: 'Vire acentuadamente à esquerda',
  15: 'Vire à esquerda',
  16: 'Mantenha-se levemente à esquerda',
  17: 'Pegue a alça',
  18: 'Pegue a alça à direita',
  19: 'Pegue a alça à esquerda',
  20: 'Pegue a saída à direita',
  21: 'Pegue a saída à esquerda',
  22: 'Siga em frente',
  23: 'Mantenha-se à direita',
  24: 'Mantenha-se à esquerda',
  25: 'Entre',
  26: 'Entre na rotatória',
  27: 'Saia da rotatória',
  28: 'Embarque na balsa',
  29: 'Desembarque da balsa',
  37: 'Entre à direita',
  38: 'Entre à esquerda',
};

export type ManeuverIcon =
  | 'straight'
  | 'right'
  | 'left'
  | 'slight-right'
  | 'slight-left'
  | 'sharp-right'
  | 'sharp-left'
  | 'uturn'
  | 'roundabout'
  | 'merge'
  | 'ferry'
  | 'arrive';

export function maneuverIcon(type: number): ManeuverIcon {
  if ([4, 5, 6].includes(type)) return 'arrive';
  if ([10, 18, 20].includes(type)) return 'right';
  if ([15, 19, 21].includes(type)) return 'left';
  if ([9, 23, 37].includes(type)) return 'slight-right';
  if ([16, 24, 38].includes(type)) return 'slight-left';
  if (type === 11) return 'sharp-right';
  if (type === 14) return 'sharp-left';
  if (type === 12 || type === 13) return 'uturn';
  if (type === 26 || type === 27) return 'roundabout';
  if (type === 25) return 'merge';
  if (type === 28 || type === 29) return 'ferry';
  return 'straight';
}

const ORDINAL = ['', 'primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta', 'sétima', 'oitava'];

export function instructionPtBR(type: number, streetNames: string[], roundaboutExit?: number): string {
  const street = streetNames[0];
  if (type === 26 && roundaboutExit) {
    const ord = ORDINAL[roundaboutExit] ?? `${roundaboutExit}ª`;
    return `Na rotatória, pegue a ${ord} saída${street ? ` para ${street}` : ''}`;
  }
  const verb = VERB[type] ?? 'Continue';
  if ([4, 5, 6].includes(type)) return verb;
  if (!street) return verb;
  const prep = type === 1 || type === 2 || type === 3 || type === 7 || type === 8 || type === 22 ? 'pela' : 'na';
  return `${verb} ${prep} ${street}`;
}

export function formatDistancePtBR(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',').replace(/,0$/, '')} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

export function formatDurationPtBR(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function spokenInstruction(m: Maneuver, distanceM: number | null): string {
  const base = m.instruction.charAt(0).toLowerCase() + m.instruction.slice(1);
  if (distanceM === null || distanceM < 40) return m.instruction;
  const spoken = formatDistancePtBR(distanceM).replace(' km', ' quilômetros').replace(' m', ' metros');
  return `Em ${spoken}, ${base}`;
}

/** Nomes das vias mais longas da rota, para identificar alternativas ("via Marginal Pinheiros"). */
export function routeVia(maneuvers: Maneuver[], count = 2): string[] {
  const byStreet = new Map<string, number>();
  for (const m of maneuvers) {
    const s = m.streetNames[0];
    if (s) byStreet.set(s, (byStreet.get(s) ?? 0) + m.distanceM);
  }
  return [...byStreet.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([s]) => s);
}
