/**
 * The messaging playground's own wiring: its flag, its relay host, its database
 * and the client built from them.
 *
 * Kept apart from the payment rails on purpose. `MESSAGE_BOX_URL_KEY` in
 * `pay/rails/handle.ts` routes payments, so pointing it at a relay chosen for
 * messaging would reroute money. This has its own key, its own default and its
 * own SQLite file; nothing here touches wallet storage or the payment host.
 *
 * The default is us-1 rather than this wallet's usual relay because live
 * delivery needs WebSockets: `messagebox.bsvblockchain.tech` runs the Go server,
 * which implements none, while `message-box-us-1.bsvb.tech` runs the TypeScript
 * one. A relay without them still delivers — the poll underneath is the
 * guarantee — but nothing is ever pushed, so every message waits for the next
 * read.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SQLite from 'expo-sqlite'
import { MessageBoxClient } from '@bsv/message-box-client'
import { GroupMessagingClient, MessageBoxTransport, TransportService } from '@bsv/group-messaging'
import type { LiveStatus, SqlDriver } from '@bsv/group-messaging'
import { makeTranscript, type Transcript } from './transcript'
import { makeChatNames, type ChatNames } from './chatNames'
import type { AppChain } from '../networks'
import { bindMessageBoxNetwork } from '../pay/rails/handle'
import { bindOriginator } from '../mandala/createRuntime'
import { profileScopedKey } from '../profiles/profileStore'
import { trimTrailingSlashes } from '../net/trimTrailingSlashes'
import { isAllowedServiceOrigin } from '../toolboxConfig'

/**
 * Where a chosen relay is remembered. Per profile, like every other host.
 *
 * Deliberately not spelled with "message_box_url" in it: that is the payment
 * rail's key, and a name containing it as a substring would match anyone
 * grepping storage for the host that routes money.
 */
export const MESSAGING_PLAYGROUND_HOST_KEY = 'messaging_playground_relay_url'

/** The TypeScript relay — the one that serves WebSockets. */
export const DEFAULT_PLAYGROUND_MESSAGE_BOX_URL = 'https://message-box-us-1.bsvb.tech'

/** The database the playground owns. Never the wallet's. */
export const PLAYGROUND_DATABASE_NAME = 'group-messaging-playground.db'

/** The box both sides read. Must match on every participant. */
export const PLAYGROUND_MESSAGE_BOX = 'group_messaging'

/**
 * The suite every device in the playground speaks.
 *
 * The library's default, now that `installCurve25519Subtle` fills in the
 * Ed25519 and X25519 that `react-native-quick-crypto` leaves out. P-256 was
 * pinned here for a while to dodge the Ed25519 keygen gap; it only moved the
 * failure into hpke's EC KEM, whose JWK export that library also gets wrong.
 *
 * Both sides have to agree, so this stays a constant rather than an option.
 */
export const PLAYGROUND_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const
/**
 * Whether the playground is built into this binary at all.
 *
 * Only the literal string turns it on, as with every other flag here. Off in
 * production until us-1 serves the live socket; see
 * `__tests__/messagingPlaygroundShipGate.test.ts`.
 */
export { messagingPlaygroundEnabled } from './playgroundFlag'

/** The saved relay for a profile, or the default when none was chosen. */
export async function readPlaygroundHost(profileIndex?: number): Promise<string> {
  const saved = await AsyncStorage.getItem(profileScopedKey(MESSAGING_PLAYGROUND_HOST_KEY, profileIndex))
  const trimmed = typeof saved === 'string' ? trimTrailingSlashes(saved.trim()) : ''
  return trimmed === '' ? DEFAULT_PLAYGROUND_MESSAGE_BOX_URL : trimmed
}

/**
 * Remember a relay, or forget it by passing an empty string.
 *
 * Rejects anything `isAllowedServiceOrigin` refuses, so a typo cannot point the
 * playground at an arbitrary origin and a pasted `http://` cannot downgrade it.
 */
export async function writePlaygroundHost(url: string, profileIndex?: number): Promise<void> {
  const key = profileScopedKey(MESSAGING_PLAYGROUND_HOST_KEY, profileIndex)
  const trimmed = trimTrailingSlashes(url.trim())
  if (trimmed === '') {
    await AsyncStorage.removeItem(key)
    return
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That is not a URL.')
  }
  if (!isAllowedServiceOrigin(parsed)) {
    throw new Error('That origin is not allowed.')
  }
  await AsyncStorage.setItem(key, trimmed)
}

/**
 * expo-sqlite's connection, as the library's `SqlDriver`.
 *
 * The method names already match — the library's interface was written against
 * this shape. The only mismatch is arity: `SqlDriver` makes `params` optional
 * and expo-sqlite's first overload makes it required, so `undefined` is not
 * assignable. Defaulting to an empty array is the whole adapter; every call
 * reaches the same connection the wallet's own storage would use.
 */
function sqlDriverFor(database: SQLite.SQLiteDatabase): SqlDriver {
  return {
    execAsync: async sql => await database.execAsync(sql),
    runAsync: async (sql, params = []) => await database.runAsync(sql, params),
    getAllAsync: async (sql, params = []) => await database.getAllAsync(sql, params),
    getFirstAsync: async (sql, params = []) => await database.getFirstAsync(sql, params)
  }
}

export interface PlaygroundClientOptions {
  /** The app's BRC-100 wallet — `managers.permissionsManager`. */
  wallet: object
  /**
   * `useWallet().adminOriginator`. The permissions manager reads a call with
   * no originator as an anonymous caller and refuses it, so both the relay
   * client and the library get the wallet with this bound.
   */
  adminOriginator: string
  chain: AppChain
  /** Overrides the saved host. Used by the screen's own host field. */
  host?: string
  profileIndex?: number
}

/**
 * Open a client for the playground.
 *
 * `live: true` is passed through `create()` rather than by building the
 * transport here: the options ride on the client, so there is no second place
 * for the poll interval and the socket flag to disagree.
 *
 * The poll is the delivery guarantee and the socket is a latency improvement
 * over it — joining a room replays no backlog, so anything that arrives while
 * the socket is down is reachable only by the next read. 5s is the library's
 * own default and is what the poll returns to whenever the socket is not
 * carrying this box's room.
 */
export interface OpenedPlayground {
  client: GroupMessagingClient
  /** What was said, which the library does not keep. */
  transcript: Transcript
  /** What this device calls each chat; the library has no rename. */
  chatNames: ChatNames
  /**
   * Close the client and the database under it.
   *
   * The database is opened here, so shutting the client alone leaves the file
   * open. Deleting it in that state leaves a native handle pointing at nothing
   * and every later query rejects.
   */
  close: () => Promise<void>
  /**
   * Live status, with the current one replayed to each new subscriber.
   *
   * The transport's own `onLiveStatus` registers a handler and replays
   * nothing, and it drops a status equal to the one before it. The socket
   * connects and joins its room while `create()` is still running, so a host
   * subscribing afterwards would wait on a change that never comes.
   */
  onLiveStatus: (listener: (status: LiveStatus) => void) => () => void
  /**
   * The backend, kept because `TransportService` holds it privately and does
   * not forward `onLiveStatus`. A host that only wants delivery can pass
   * `transport: { client, live: true }` to `create()` and never see this; a
   * host that wants to show what the socket is doing has to build it.
   */
  transport: MessageBoxTransport
}

/**
 * Open a client for the playground, and hand back the transport with it.
 *
 * The poll is the delivery guarantee and the socket is a latency improvement
 * over it — joining a room replays no backlog, so anything that arrives while
 * the socket is down is reachable only by the next read. 5s is what the poll
 * returns to whenever the socket is not carrying this box's room.
 */
/**
 * Clear the playground's chats and invitations.
 *
 * Only this database. Contacts, keys and transactions live in the wallet's own
 * file, so there is nothing here that could reach them — which is the point of
 * the playground having a database of its own.
 *
 * The caller closes the client first: SQLite will not remove a file the
 * process still holds open.
 */
export async function deletePlaygroundData(): Promise<void> {
  await SQLite.deleteDatabaseAsync(PLAYGROUND_DATABASE_NAME)
}

export async function openPlaygroundClient(options: PlaygroundClientOptions): Promise<OpenedPlayground> {
  const host = options.host ?? (await readPlaygroundHost(options.profileIndex))
  const wallet = bindOriginator(options.wallet, options.adminOriginator)
  // Logging on in development: the relay is the one part of this flow with no
  // other witness, and a message that silently went to the wrong mailbox looks
  // exactly like one that was never sent.
  const box = bindMessageBoxNetwork(
    new MessageBoxClient({ host, walletClient: wallet as never, enableLogging: __DEV__ }),
    options.chain
  )
  const database = await SQLite.openDatabaseAsync(PLAYGROUND_DATABASE_NAME)
  const transcript = await makeTranscript(database)
  const chatNames = await makeChatNames(database)
  const transport = new MessageBoxTransport(box as never, {
    live: true,
    pollIntervalMs: 5000,
    messageBox: PLAYGROUND_MESSAGE_BOX
  })

  // Subscribed here, before create() starts the transport, so the socket
  // settling is not announced to an empty room.
  let latest: LiveStatus | undefined
  const listeners = new Set<(status: LiveStatus) => void>()
  transport.onLiveStatus(status => {
    latest = status
    for (const listener of listeners) listener(status)
  })
  const onLiveStatus = (listener: (status: LiveStatus) => void) => {
    listeners.add(listener)
    if (latest !== undefined) listener(latest)
    return () => listeners.delete(listener)
  }

  const client = await GroupMessagingClient.create({
    wallet: wallet as never,
    ciphersuite: PLAYGROUND_CIPHERSUITE,
    storage: sqlDriverFor(database),
    transport: new TransportService(transport)
  })
  const close = async () => {
    try {
      await client.close()
    } finally {
      await database.closeAsync()
    }
  }

  return { client, transport, transcript, chatNames, onLiveStatus, close }
}
