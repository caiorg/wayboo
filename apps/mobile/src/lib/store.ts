import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';

/**
 * URL padrão da API: variável EXPO_PUBLIC_API_URL; senão, o IP da máquina que serve o
 * bundle em desenvolvimento (funciona em aparelho físico na mesma rede); senão localhost.
 */
function defaultApiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host && Platform.OS !== 'web') return `http://${host}:8787`;
  if (Platform.OS === 'android') return 'http://10.0.2.2:8787';
  return 'http://localhost:8787';
}

/** Chave usada antes da renomeação para Wayboo. É lida uma vez para manter o `userId` e as preferências. */
const LEGACY_SETTINGS_KEY = 'trajeto-settings';

/**
 * Lê a chave nova; sem valor nela, move o da chave antiga para ela. Com valor, apaga a antiga,
 * que sobra se o app parou entre gravar a nova e apagar a antiga.
 */
async function readSettings(name: string): Promise<string | null> {
  const value = await AsyncStorage.getItem(name);
  if (value !== null) {
    try {
      await AsyncStorage.removeItem(LEGACY_SETTINGS_KEY);
    } catch {
      // Só preferências antigas, sem token: a próxima abertura tenta de novo.
    }
    return value;
  }
  const legacy = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
  if (legacy !== null) {
    await AsyncStorage.setItem(name, legacy);
    await AsyncStorage.removeItem(LEGACY_SETTINGS_KEY);
  }
  return legacy;
}

/** O secure store não existe na web; lá o token continua no AsyncStorage. */
const secureTokens = Platform.OS !== 'web';

/** Chave do token de um servidor. O secure store só aceita letras, números, `.`, `-` e `_`; `_XX` escapa o resto da URL. */
function tokenKey(apiUrl: string): string {
  const escaped = encodeURIComponent(apiUrl).replace(/[^A-Za-z0-9.\-%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `wayboo-token.${escaped.replace(/%/g, '_')}`;
}

/** Token gravado no secure store por servidor: evita regravar a cada ajuste e diz o que apagar. */
const secureSaved = new Map<string, string>();

/**
 * Grava os tokens no secure store e devolve as credenciais sem eles, para o AsyncStorage.
 * Se o secure store recusar um token, ele fica no AsyncStorage como antes: perder a sessão é pior.
 */
async function moveTokensToSecureStore(credentials: Record<string, DeviceCredential>): Promise<Record<string, Partial<DeviceCredential>>> {
  const rest: Record<string, Partial<DeviceCredential>> = {};
  for (const [url, { token, ...withoutToken }] of Object.entries(credentials)) {
    rest[url] = withoutToken;
    if (secureSaved.get(url) === token) continue;
    try {
      await SecureStore.setItemAsync(tokenKey(url), token);
      secureSaved.set(url, token);
    } catch {
      rest[url] = { token, ...withoutToken };
    }
  }
  for (const url of [...secureSaved.keys()]) {
    if (url in credentials) continue;
    try {
      await SecureStore.deleteItemAsync(tokenKey(url));
      secureSaved.delete(url);
    } catch {
      // Fica em `secureSaved`: a próxima gravação tenta apagar de novo.
    }
  }
  return rest;
}

type Persisted = StorageValue<Settings>;

/** O zustand não espera um `setItem` antes do próximo: sem fila, uma gravação antiga poderia terminar por último. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

let lastSave: Promise<void> = Promise.resolve();
/** Termina quando a última gravação pedida chega ao AsyncStorage; rejeita se ela falhou. */
export function settingsSaved(): Promise<void> {
  return lastSave;
}

async function writeSettings(name: string, value: Persisted): Promise<void> {
  const state = secureTokens ? { ...value.state, credentials: await moveTokensToSecureStore(value.state.credentials ?? {}) } : value.state;
  await AsyncStorage.setItem(name, JSON.stringify({ ...value, state }));
}

/**
 * Ajustes no AsyncStorage; no nativo, tokens no secure store. O token em texto puro de versões
 * anteriores vale até ser movido e, depois de gravado no secure store, sai do AsyncStorage.
 */
const settingsStorage: PersistStorage<Settings> = {
  getItem: (name) =>
    serial(async () => {
      const raw = await readSettings(name);
      if (raw === null) return null;
      const value = JSON.parse(raw) as Persisted;
      if (!secureTokens) return value;
      const stored = (value.state.credentials ?? {}) as Record<string, Partial<DeviceCredential>>;
      const credentials: Record<string, DeviceCredential> = {};
      let plainText = false;
      for (const [url, saved] of Object.entries(stored)) {
        // Erro de leitura sobe para a hidratação: registrar outro token trocaria a identidade.
        const secure = await SecureStore.getItemAsync(tokenKey(url));
        if (secure !== null) secureSaved.set(url, secure);
        if (saved.token) plainText = true;
        const token = saved.token ?? secure;
        // Sem token, a credencial não serve; o app registra o aparelho de novo.
        if (token) credentials[url] = { ...saved, token };
      }
      value.state = { ...value.state, credentials };
      if (plainText) {
        try {
          await writeSettings(name, value);
        } catch {
          // A sessão já está em memória; a próxima gravação tenta de novo.
        }
      }
      return value;
    }),
  // Antes da hidratação, ou se ela falhou, o estado em memória é o padrão (outro `userId`, sem credenciais):
  // gravá-lo apagaria a identidade salva. O zustand não grava ao aplicar o estado lido.
  setItem: (name, value) => {
    if (!useSettings.persist.hasHydrated()) return Promise.resolve();
    lastSave = serial(() => writeSettings(name, value));
    return lastSave;
  },
  removeItem: (name) =>
    serial(async () => {
      await AsyncStorage.removeItem(name);
      if (secureTokens) await moveTokensToSecureStore({});
    }),
};

export type ThemePref = 'system' | 'light' | 'dark';

/** Mesma forma na chave das credenciais e no envio: `https://x/` e `https://x` são o mesmo servidor. */
export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Credencial deste aparelho num servidor. O aparelho gera o token e o grava antes de registrá-lo;
 * `userId` só existe depois que `POST /auth/device` confirmou o registro.
 */
export interface DeviceCredential {
  token: string;
  userId?: string;
}

/** Estilos de mapa que o servidor `apiUrl` anunciou em `/health` (self-host). */
export interface ServerMap {
  apiUrl: string;
  light: string;
  dark: string;
}

/** Provedores que a API aceita com a chave do usuário (`/health` → `byok`). */
export const AI_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** IA com a chave do usuário. A chave em si fica fora dos ajustes (`aiKey.ts`). */
export interface AiChoice {
  provider: AiProviderId;
  model: string;
}

interface Settings {
  /** UUID anônimo do aparelho, de antes dos tokens. Vai em `legacyUserId` para o servidor adotar os dados antigos. */
  userId: string;
  /** Uma credencial por servidor (chave: `normalizeApiUrl`), para voltar a um servidor sem perder a identidade. */
  credentials: Record<string, DeviceCredential>;
  apiUrl: string;
  /** Salvo para o mapa do servidor próprio abrir já no próximo início, sem passar pelo OpenFreeMap. */
  serverMap: ServerMap | null;
  voice: boolean;
  theme: ThemePref;
  avoidTolls: boolean;
  avoidHighways: boolean;
  /** `null`: a IA do servidor. */
  ai: AiChoice | null;
  set: (patch: Partial<Omit<Settings, 'set' | 'setCredential' | 'resetIdentity' | 'userId' | 'credentials'>>) => void;
  setCredential: (apiUrl: string, credential: DeviceCredential) => void;
  /** Depois de apagar os dados: descarta a credencial de `apiUrl` e gera outro `userId`, que o servidor adota como usuário novo. */
  resetIdentity: (apiUrl: string) => void;
}

/** Resolve com o erro da leitura do AsyncStorage (ou `null`) quando a hidratação termina. */
let finishHydration: (error: unknown) => void = () => {};
export const settingsHydration = new Promise<unknown>((resolve) => {
  finishHydration = resolve;
});

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      userId: randomUUID(),
      credentials: {},
      apiUrl: defaultApiUrl(),
      serverMap: null,
      voice: true,
      theme: 'system',
      avoidTolls: false,
      avoidHighways: false,
      ai: null,
      set: (patch) => set(patch),
      setCredential: (apiUrl, credential) =>
        set((s) => ({ credentials: { ...s.credentials, [normalizeApiUrl(apiUrl)]: credential } })),
      resetIdentity: (apiUrl) =>
        set((s) => {
          const { [normalizeApiUrl(apiUrl)]: _discarded, ...credentials } = s.credentials;
          return { userId: randomUUID(), credentials };
        }),
    }),
    {
      name: 'wayboo-settings',
      storage: settingsStorage,
      // O zustand não marca `hasHydrated` nem avisa `onFinishHydration` quando a leitura falha.
      onRehydrateStorage: () => (_state, error) => finishHydration(error ?? null),
    },
  ),
);

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  } catch {
    return 'America/Sao_Paulo';
  }
}
