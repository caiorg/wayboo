/** Na web não há localização com a aba em segundo plano: a navegação segue só com a tela ligada. */
export const BACKGROUND_LOCATION_SUPPORTED = false;

export async function startBackgroundLocation(_destinationName: string | null): Promise<boolean> {
  return false;
}

export async function stopBackgroundLocation(): Promise<void> {}
