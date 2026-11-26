import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
// Importado na abertura para definir a task de localização antes de o sistema entregar leituras.
import { stopBackgroundLocation } from '@/lib/backgroundLocation';
import { settingsHydration, useSettings } from '@/lib/store';
import { useTheme } from '@/lib/theme';

export default function RootLayout() {
  const t = useTheme();
  const apiUrl = useSettings((s) => s.apiUrl);
  // Sem esperar os ajustes, o mapa abriria com o estilo público antes de ler o do servidor próprio.
  const [hydrated, setHydrated] = useState(() => useSettings.persist.hasHydrated());

  useEffect(() => {
    void settingsHydration.then(() => setHydrated(true));
  }, []);

  useEffect(() => {
    // Nenhuma navegação está ativa na abertura: desliga o GPS que uma sessão encerrada no meio da viagem deixou ligado.
    void stopBackgroundLocation();
  }, []);

  useEffect(() => {
    // Atualiza o mapa anunciado pelo servidor. Sem conexão, fica o estilo gravado (ou o público).
    void settingsHydration.then(() => api.health()).catch(() => {});
  }, [apiUrl]);

  if (!hydrated) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerTintColor: t.text,
          headerStyle: { backgroundColor: t.surface },
          headerTransparent: false,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false, title: 'Mapa' }} />
        <Stack.Screen name="insights" options={{ title: 'Aprendizado' }} />
        <Stack.Screen name="settings" options={{ title: 'Ajustes' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
