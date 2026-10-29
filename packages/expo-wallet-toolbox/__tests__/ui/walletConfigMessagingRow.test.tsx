/**
 * The Messaging playground's only entrance.
 *
 * WalletConfigScreen is the screen the home gear actually opens
 * (`router.push('/wallet-config')`). SettingsScreen is exported from the
 * toolbox barrel but no route in this app mounts it, so a row added there is
 * unreachable here — which is the mistake this test exists to stop repeating.
 *
 * Mock surface is lifted from walletConfigArc.test.tsx: this screen needs most
 * of the wallet around it before it will render at all.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WalletConfigScreen } from '../../ui/screens/WalletConfigScreen'
import { fake as secureStoreFake } from '../__mocks__/secureStoreFake'

const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockEnabled = true
jest.mock('../../core/messaging/playgroundFlag', () => ({ messagingPlaygroundEnabled: () => mockEnabled }))
let mockWallet: any

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('../../ui/components/ui/SlideOverFromRight', () => ({ __esModule: true, default: () => null }))
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false }))
}))
jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    ...jest.requireActual('../../core/theme/motion'),
    ...jest.requireActual('../../core/numberFormat'),
    splitAmountFraction: jest.requireActual('../../core/amountFormatHelpers').splitAmountFraction,
    isFiatCurrency: jest.requireActual('../../core/amountFormatHelpers').isFiatCurrency,
    validateArcUrl: jest.requireActual('../../core/net/validateArcUrl').validateArcUrl,
    useTheme: () => ({ colors: {} }),
    useWallet: () => mockWallet,
    useLocalStorage: () => ({
      hasStoredIdentity: jest.fn(async () => true),
      createMnemonic: jest.fn(),
      getMnemonic: jest.fn(),
      getRecoveredKey: jest.fn(async () => null),
      secretsReady: true
    }),
    backupAttestation: jest.requireActual('../../core/services/vault/backupAttestation').backupAttestation,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 1000 }),
    UserContext: React.createContext({ appName: 'Test Wallet' }),
    formatAmountParts: () => ({ integer: '0', fraction: '', unit: 'BSV' }),
    formatAmount: () => '0',
    formatSatoshisAsBsvDecimal: () => '0',
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => true,
    isVaultAvailable: (chain: string) => chain === 'main',
    useVault: () => ({
      state: { phase: 'idle' },
      submitPin: jest.fn(),
      cancel: jest.fn(),
      retry: jest.fn(),
      hasVaultMeta: false
    }),
    arcUrlStorageKey: () => 'arc_url',
    arcApiTokenStorageKey: () => 'arc_token',
    getArcApiToken: jest.requireActual('../../core/services/arcTokenStorage').getArcApiToken,
    setArcApiToken: jest.requireActual('../../core/services/arcTokenStorage').setArcApiToken,
    DEFAULT_ARC_URLS: { main: 'https://arc.gorillapool.io' },
    KNOWN_ARC_URLS: { main: [] },
    DISPLAY_CURRENCY_OPTIONS: [],
    DEFAULT_AUTO_APPROVE_THRESHOLD: 0,
    AUTO_APPROVE_STORAGE_KEY: 'auto_approve',
    ADVANCED_SETTINGS_EXPANDED_KEY: 'advanced',
    getBackupUrl: () => ''
  }
})
jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => ({ section: undefined }),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect])
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { number?: number; profile?: string }) =>
      key === 'profile_label' ? `profile${o?.number}` : o?.profile ? `${key}:${o.profile}` : key
  })
}))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/wallet/BackupReminderSheet', () => ({ BackupReminderSheet: () => null }))
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/wallet/ImportFromBackupPrompt', () => ({ ImportFromBackupPrompt: () => null }))
jest.mock('../../ui/components/wallet/ActivityRow', () => () => null)
jest.mock('../../ui/components/security/WalletLockNotice', () => () => null)
jest.mock('../../ui/components/pay/OfflineNotice', () => () => null)
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => false }))
jest.mock('../../ui/hooks/useOfflineNoticeActions', () => ({ useOfflineNoticeActions: () => ({}) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/exportTransactions', () => ({ exportTransactionsAsCsv: jest.fn() }))
jest.mock('../../ui/components/ui/ScreenGradient', () => ({
  __esModule: true,
  default: ({ children }: any) => children
}))
jest.mock('../../ui/components/ui/ScrollFade', () => ({
  __esModule: true,
  default: () => null,
  sampleScreenGradient: () => '#000000'
}))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/ListRow', () => {
  const React = require('react')
  const { Pressable, Text } = require('react-native')
  return {
    ListRow: ({ label, onPress }: any) =>
      React.createElement(Pressable, { onPress }, React.createElement(Text, {}, label))
  }
})
jest.mock('../../ui/components/ui/GroupedList', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return {
    GroupedSection: ({ children, footer }: any) =>
      React.createElement(React.Fragment, {}, children, footer ? React.createElement(Text, {}, footer) : null)
  }
})
jest.mock('../../ui/components/pay/MessageBoxConfig', () => ({
  ConfigPanel: () => null,
  useMessageBoxConfig: () => ({ messageBoxUrl: 'https://test.invalid' })
}))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('../../ui/exportDatabases', () => ({ exportAllWalletDatabases: jest.fn() }))
jest.mock('../../ui/importDatabases', () => ({ importWalletDatabase: jest.fn() }))
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn() } }))

const mockRebuildWallet = jest.fn(async () => {})

beforeEach(async () => {
  jest.clearAllMocks()
  mockEnabled = true
  await AsyncStorage.clear()
  secureStoreFake.__reset()
  mockWallet = {
    managers: { permissionsManager: { getPublicKey: jest.fn(async () => ({ publicKey: '02' + 'a'.repeat(64) })) } },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: null,
    logout: jest.fn(),
    switchNetwork: jest.fn(),
    updateSettings: jest.fn(async () => {}),
    rebuildWallet: mockRebuildWallet
  }
})

async function renderConfig() {
  const screen = render(<WalletConfigScreen />)
  await act(async () => {})
  return screen
}

describe('WalletConfigScreen messaging row', () => {
  it('opens the playground when the flag is on', async () => {
    const screen = await renderConfig()

    await act(async () => fireEvent.press(screen.getByText('messaging_title')))
    expect(mockRouter.push).toHaveBeenCalledWith('/messaging')
  })

  it('is absent when the flag is off', async () => {
    mockEnabled = false
    const screen = await renderConfig()

    expect(screen.queryByText('messaging_title')).toBeNull()
  })
})
