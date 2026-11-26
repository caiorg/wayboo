import { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { normalizeApiUrl, useSettings } from './store';

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  /** Cor do que vem do aprendizado / IA */
  learn: string;
  learnSoft: string;
  success: string;
  warning: string;
  danger: string;
  routeAlt: string;
  shadow: string;
  mapStyle: string;
}

const light: Theme = {
  dark: false,
  bg: '#F4F6FA',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF1F6',
  border: '#DDE2EA',
  text: '#0E1726',
  textMuted: '#5B6678',
  primary: '#1F5EFF',
  primaryText: '#FFFFFF',
  learn: '#7A4DFF',
  learnSoft: '#EFE9FF',
  success: '#0E9F6E',
  warning: '#D97706',
  danger: '#DC2626',
  routeAlt: '#94A3B8',
  shadow: 'rgba(14, 23, 38, 0.16)',
  mapStyle: 'https://tiles.openfreemap.org/styles/liberty',
};

const dark: Theme = {
  dark: true,
  bg: '#0B1220',
  surface: '#131C2E',
  surfaceAlt: '#1B2640',
  border: '#26324D',
  text: '#EAF0FA',
  textMuted: '#94A3B8',
  primary: '#4C82FF',
  primaryText: '#FFFFFF',
  learn: '#A78BFA',
  learnSoft: '#2A2150',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
  routeAlt: '#64748B',
  shadow: 'rgba(0, 0, 0, 0.5)',
  mapStyle: 'https://tiles.openfreemap.org/styles/dark',
};

/** Estilos claro e escuro do mapa no servidor atual: os do self-host, se ele anunciou, ou os públicos. */
export function useMapStyles(): { light: string; dark: string } {
  const apiUrl = useSettings((s) => s.apiUrl);
  const serverMap = useSettings((s) => s.serverMap);
  return useMemo(() => {
    // Estilo gravado de outro servidor não vale para o atual.
    if (!serverMap || serverMap.apiUrl !== normalizeApiUrl(apiUrl)) return { light: light.mapStyle, dark: dark.mapStyle };
    return { light: serverMap.light, dark: serverMap.dark };
  }, [apiUrl, serverMap]);
}

export function useTheme(): Theme {
  const system = useColorScheme();
  const pref = useSettings((s) => s.theme);
  const styles = useMapStyles();
  const isDark = pref === 'system' ? system === 'dark' : pref === 'dark';
  // Memo: o tema entra em dependências de efeitos e memos do mapa.
  return useMemo(() => {
    const base = isDark ? dark : light;
    const mapStyle = isDark ? styles.dark : styles.light;
    return mapStyle === base.mapStyle ? base : { ...base, mapStyle };
  }, [isDark, styles]);
}

export const ALERT_COLORS: Record<string, string> = {
  accident: '#DC2626',
  traffic: '#EA580C',
  hazard: '#D97706',
  pothole: '#A16207',
  police: '#2563EB',
  speed_camera: '#7C3AED',
  road_closed: '#111827',
  flood: '#0891B2',
};

export const ALERT_LABELS: Record<string, string> = {
  accident: 'Acidente',
  traffic: 'Trânsito parado',
  hazard: 'Perigo na via',
  pothole: 'Buraco',
  police: 'Polícia',
  speed_camera: 'Radar',
  road_closed: 'Via interditada',
  flood: 'Alagamento',
};

export const ALERT_ICONS: Record<string, string> = {
  accident: 'car-emergency',
  traffic: 'car-multiple',
  hazard: 'alert',
  pothole: 'road-variant',
  police: 'police-badge',
  speed_camera: 'camera',
  // Placa de sentido proibido; `road-variant` já é o buraco.
  road_closed: 'minus-circle',
  flood: 'waves',
};
