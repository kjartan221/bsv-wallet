/**
 * The playground's wallet must carry the admin originator.
 *
 * `WalletPermissionsManager` treats a call with no originator as an anonymous
 * caller, so `getPublicKey` fails rather than returning the identity key —
 * on device that surfaced as "Identity key retrieval failed", then
 * `LiveDeliveryUnavailable`, then a poll that could not authenticate against
 * any host. WalletContext binds the originator everywhere it builds a
 * MessageBoxClient and says why; the playground has to do the same.
 *
 * Both consumers need it: the relay client calls getPublicKey/createSignature
 * for BRC-103 auth, and the library derives its BRC-43 keys through the same
 * wallet.
 */
const captured: { boxWallet?: any; libWallet?: any; ciphersuite?: string } = {}

// The repo's expo-sqlite mock throws on purpose; this file never touches a
// database, it only needs openDatabaseAsync to hand something back.
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => undefined,
    runAsync: async () => undefined,
    getAllAsync: async () => []
  })
}))

jest.mock('@bsv/message-box-client', () => ({
  MessageBoxClient: class {
    constructor(opts: { host: string; walletClient: unknown }) {
      captured.boxWallet = opts.walletClient
    }
  }
}))

jest.mock('@bsv/group-messaging', () => ({
  GroupMessagingClient: {
    create: async (opts: { wallet: unknown; ciphersuite?: string }) => {
      captured.libWallet = opts.wallet
      captured.ciphersuite = opts.ciphersuite
      return { identityKey: '02ab' }
    }
  },
  MessageBoxTransport: class {
    onLiveStatus() {
      return () => undefined
    }
  },
  TransportService: class {}
}))

// bindMessageBoxNetwork only tags the client with its chain; the originator is
// what this file is about, so keep it out of the way.
jest.mock('../../core/pay/rails/handle', () => ({
  bindMessageBoxNetwork: (client: unknown) => client,
  MESSAGE_BOX_URL_KEY: 'message_box_url'
}))

import { openPlaygroundClient } from '../../core/messaging/playground'

const ADMIN = 'admin.example'

function recordingWallet() {
  const calls: { method: string; originator?: string }[] = []
  return {
    calls,
    wallet: {
      getPublicKey: async (_args: unknown, originator?: string) => {
        calls.push({ method: 'getPublicKey', originator })
        return { publicKey: '02' + 'a'.repeat(64) }
      },
      createSignature: async (_args: unknown, originator?: string) => {
        calls.push({ method: 'createSignature', originator })
        return { signature: [] }
      }
    }
  }
}

beforeEach(() => {
  captured.boxWallet = undefined
  captured.libWallet = undefined
  captured.ciphersuite = undefined
})

describe('the playground wallet', () => {
  it('reaches the relay client with the admin originator bound', async () => {
    const { calls, wallet } = recordingWallet()

    await openPlaygroundClient({
      wallet,
      chain: 'test',
      host: 'https://relay.example.test',
      adminOriginator: ADMIN
    })

    await captured.boxWallet.getPublicKey({ identityKey: true })
    expect(calls).toEqual([{ method: 'getPublicKey', originator: ADMIN }])
  })

  it('reaches the library with the admin originator bound', async () => {
    const { calls, wallet } = recordingWallet()

    await openPlaygroundClient({
      wallet,
      chain: 'test',
      host: 'https://relay.example.test',
      adminOriginator: ADMIN
    })

    await captured.libWallet.createSignature({})
    expect(calls).toEqual([{ method: 'createSignature', originator: ADMIN }])
  })

  it('lets an explicit originator through unchanged', async () => {
    const { calls, wallet } = recordingWallet()

    await openPlaygroundClient({
      wallet,
      chain: 'test',
      host: 'https://relay.example.test',
      adminOriginator: ADMIN
    })

    await captured.boxWallet.getPublicKey({ identityKey: true }, 'someone.else')
    expect(calls).toEqual([{ method: 'getPublicKey', originator: 'someone.else' }])
  })
})

describe('the playground ciphersuite', () => {
  it('pins the suite explicitly, so both devices agree', async () => {
    await openPlaygroundClient({
      wallet: recordingWallet().wallet,
      chain: 'test',
      host: 'https://relay.example.test',
      adminOriginator: ADMIN
    })

    // The library's default. It only works on device because the Curve25519
    // shim fills in the Ed25519 and X25519 quick-crypto's subtle is missing.
    expect(captured.ciphersuite).toBe('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519')
  })
})
