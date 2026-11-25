import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { useSettings, type AiChoice } from './store';

/**
 * Chave de IA do usuário (BYOK). Fica numa entrada própria, fora de `wayboo-settings`: os ajustes guardam só o
 * provedor e o modelo. No celular vai para o secure store, presa a este aparelho. Na web não há secure store, e a
 * chave fica no armazenamento local do navegador.
 */
export const AI_KEY_STORE = 'wayboo-ai-key';

export const aiKeyInBrowser = () => Platform.OS === 'web';

/** Mesmo formato que a API aceita: ASCII visível, sem espaço, de 20 a 512 caracteres. */
const KEY = /^[\x21-\x7e]{20,512}$/;
const MODEL = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export async function readAiKey(): Promise<string | null> {
  return aiKeyInBrowser() ? AsyncStorage.getItem(AI_KEY_STORE) : SecureStore.getItemAsync(AI_KEY_STORE);
}

export async function hasAiKey(): Promise<boolean> {
  return (await readAiKey()) !== null;
}

/**
 * Grava a escolha. `key` nulo mantém a chave já salva, para trocar só o modelo. As mensagens de erro não repetem a chave.
 */
export async function saveAi(choice: AiChoice, key: string | null): Promise<void> {
  const model = choice.model.trim();
  if (!MODEL.test(model)) throw new Error('Informe o nome do modelo, sem espaços (ex.: gpt-4o-mini).');
  const k = key?.trim() ?? null;
  if (k !== null && !KEY.test(k)) throw new Error('A chave parece incompleta: cole a chave inteira, sem espaços.');
  if (k === null && !(await hasAiKey())) throw new Error('Cole a chave do provedor.');
  if (k !== null) {
    if (aiKeyInBrowser()) await AsyncStorage.setItem(AI_KEY_STORE, k);
    // Só com o aparelho desbloqueado e sem ir para backup ou outro aparelho.
    else await SecureStore.setItemAsync(AI_KEY_STORE, k, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  useSettings.getState().set({ ai: { provider: choice.provider, model } });
}

/** Apaga a chave do aparelho e volta para a IA do servidor. */
export async function clearAi(): Promise<void> {
  useSettings.getState().set({ ai: null });
  if (aiKeyInBrowser()) await AsyncStorage.removeItem(AI_KEY_STORE);
  else await SecureStore.deleteItemAsync(AI_KEY_STORE);
}
