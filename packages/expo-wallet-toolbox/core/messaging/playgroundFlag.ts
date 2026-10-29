/**
 * Is the messaging playground built into this app?
 *
 * Its own module because `playground.ts` pulls in expo-sqlite, the MessageBox
 * client and the MLS engine, and the Settings screen — which every user opens —
 * only needs to know whether to draw one row.
 *
 * `__DEV__` is false in a release build, so the flag is the only gate that
 * reaches TestFlight; `__tests__/messagingPlaygroundShipGate.test.ts` pins
 * which EAS profiles set it.
 */
export function messagingPlaygroundEnabled(): boolean {
  return process.env.EXPO_PUBLIC_MESSAGING_PLAYGROUND === 'true'
}
