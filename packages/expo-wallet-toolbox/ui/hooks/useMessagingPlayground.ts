/**
 * One playground client for the app, shared by the list and the thread.
 *
 * Module-scoped rather than a context provider: the playground is flag-gated
 * and must add nothing to the root layout for builds that do not have it. The
 * client is opened once on first use and kept for the session — it owns a
 * socket, and opening a second one per screen would mean two sockets on the
 * same identity racing for the same room.
 *
 * Nothing here closes it. A playground that reopened its client on every
 * navigation would spend most of its life reconnecting, and the socket is the
 * thing under test.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GroupMessagingClient, LiveStatus } from '@bsv/group-messaging'
import type { Failure } from '../../core/messaging/managedInvitations'
import { deletePlaygroundData, openPlaygroundClient } from '../../core/messaging/playground'
import { messageIdOf } from '../../core/messaging/messageIds'
import { ManagedInvitations, MemoryShelf } from '../../core/messaging/managedInvitations'
import { PlaygroundChatIds } from '../../core/messaging/playgroundChatIds'
import type { AppChain } from '../../core/networks'
import type { Transcript } from '../../core/messaging/transcript'
import type { ChatNames } from '../../core/messaging/chatNames'

export interface PlaygroundHandle {
  client: GroupMessagingClient | undefined
  invitations: ManagedInvitations | undefined
  chatIds: PlaygroundChatIds | undefined
  /** Appended to as the exchange fails; the screens surface the last one. */
  failures: Failure[]
  /** What was said. The library keeps group state, not messages. */
  transcript: Transcript | undefined
  /** Local chat names; the library has no rename. */
  chatNames: ChatNames | undefined
  /** What the live socket is doing, once it has said anything. */
  live: LiveStatus | undefined
  /** Set when opening failed; the screen shows it rather than a blank list. */
  error: string | undefined
  opening: boolean
  /** Re-open after a failure, or after the host was changed. */
  reopen: () => void
  /** Close the client, clear chats and invitations, and open a fresh one. */
  reset: () => Promise<void>
  /** Subscribe to "an invitation finished", to re-read what it may have changed. */
  onInvitationSettled: (listener: () => void) => () => void
}

interface Opened {
  client: GroupMessagingClient
  invitations: ManagedInvitations
  transcript: Transcript
  chatNames: ChatNames
  /** Closes the client and the database together. */
  close: () => Promise<void>
  /** The invite -> chat mapping the exchange reads; the screen writes it. */
  chatIds: PlaygroundChatIds
  /** Failures the exchange reports, since nobody awaits a Welcome. */
  failures: Failure[]
  /**
   * Held because `TransportService` does not forward `onLiveStatus`, and
   * replaying because the transport's own does not.
   */
  onLiveStatus: (listener: (status: LiveStatus) => void) => () => void
  /**
   * Failures, replayed to each new subscriber.
   *
   * The client is shared and outlives any one screen, so a screen opened after
   * an exchange failed still has to be able to show what went wrong.
   */
  onFailure: (listener: (reported: Failure[]) => void) => () => void
  /**
   * An admit or join has finished, so stored state may have changed.
   *
   * The library emits nothing when `joinFromWelcome` creates a group, which
   * leaves a host with no reason to re-read its list.
   */
  onSettled: (listener: () => void) => () => void
}

let opened: Promise<Opened> | undefined
let openedFor: string | undefined

/** Drop the shared client so the next use opens a new one. */
export function resetPlaygroundClient(): void {
  void closePlaygroundClient()
}

/**
 * The same, but awaitable.
 *
 * Deleting the database needs the close to have finished: SQLite will not
 * remove a file the process still holds open.
 */
export async function closePlaygroundClient(): Promise<void> {
  const previous = opened
  opened = undefined
  openedFor = undefined
  if (previous === undefined) return
  try {
    const o = await previous
    await o.close()
  } catch {
    // An open that failed has nothing to close, and a close that fails must
    // not stop the caller from clearing the data anyway.
  }
}

async function openOnce(
  wallet: object,
  adminOriginator: string,
  chain: AppChain,
  host: string | undefined
): Promise<Opened> {
  const key = `${chain}:${host ?? ''}`
  if (opened !== undefined && openedFor === key) return await opened
  if (opened !== undefined) resetPlaygroundClient()
  openedFor = key
  opened = (async () => {
    const { client, transcript, chatNames, onLiveStatus, close } = await openPlaygroundClient({
      wallet,
      adminOriginator,
      chain,
      ...(host === undefined ? {} : { host })
    })
    const chatIds = new PlaygroundChatIds()
    // Replaced rather than mutated on every report: the hook holds this in
    // state, and pushing into an array React already has changes nothing it
    // can see, so the failure never reaches the screen.
    let failures: Failure[] = []
    const listeners = new Set<(reported: Failure[]) => void>()
    const settledListeners = new Set<() => void>()
    const invitations = new ManagedInvitations(
      client,
      new MemoryShelf(),
      chatIds,
      failure => {
        failures = [...failures, failure]
        for (const listener of listeners) listener(failures)
      },
      () => {
        for (const listener of settledListeners) listener()
      }
    )
    invitations.start()

    // Recorded here rather than on the thread screen: a message that arrives
    // while the chat is closed is still part of it, and the library hands each
    // one to a subscriber exactly once.
    client.on('message', ({ chatId, sender, content }) => {
      // Every type, not only text. A reply or a reaction that was dropped
      // here would be a message the library delivered exactly once and this
      // host threw away.
      void transcript
        .append({ chatId, id: messageIdOf(content), sender, at: Date.now(), content })
        .catch(() => undefined)
    })

    return {
      client,
      transcript,
      chatNames,
      close,
      invitations,
      chatIds,
      failures,
      onLiveStatus,
      onFailure: listener => {
        listeners.add(listener)
        if (failures.length > 0) listener(failures)
        return () => listeners.delete(listener)
      },
      onSettled: listener => {
        settledListeners.add(listener)
        return () => settledListeners.delete(listener)
      }
    }
  })()
  try {
    return await opened
  } catch (cause) {
    // A failed open must not be cached, or every retry returns the failure.
    opened = undefined
    openedFor = undefined
    throw cause
  }
}

/**
 * The shared client, opened on first use.
 *
 * `wallet` is the app's BRC-100 wallet (`managers.permissionsManager`). The
 * hook does nothing until it exists, so a screen mounted before the wallet is
 * ready simply reports `opening`.
 */
export function useMessagingPlayground(
  wallet: object | undefined,
  adminOriginator: string,
  chain: AppChain,
  host?: string
): PlaygroundHandle {
  const [state, setState] = useState<Omit<PlaygroundHandle, 'reopen' | 'reset' | 'onInvitationSettled'>>({
    client: undefined,
    invitations: undefined,
    chatIds: undefined,
    failures: [],
    transcript: undefined,
    chatNames: undefined,
    live: undefined,
    error: undefined,
    opening: wallet !== undefined
  })
  const [attempt, setAttempt] = useState(0)
  // Held in a ref so a subscriber taken before the client opened still works
  // once it has.
  const settled = useRef<(listener: () => void) => () => void>(() => () => undefined)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (wallet === undefined) return
    let stopStatus: (() => void) | undefined
    let stopFailures: (() => void) | undefined
    setState(s => ({ ...s, opening: true, error: undefined }))
    void openOnce(wallet, adminOriginator, chain, host)
      .then(({ client, invitations, chatIds, failures, transcript, chatNames, onLiveStatus, onFailure, onSettled }) => {
        if (!alive.current) return
        setState({
          client,
          invitations,
          chatIds,
          transcript,
          chatNames,
          failures,
          live: undefined,
          error: undefined,
          opening: false
        })
        stopStatus = onLiveStatus(status => {
          if (alive.current) setState(s => ({ ...s, live: status }))
        })
        stopFailures = onFailure(reported => {
          if (alive.current) setState(s => ({ ...s, failures: reported }))
        })
        settled.current = onSettled
      })
      .catch((cause: unknown) => {
        if (!alive.current) return
        setState({
          client: undefined,
          invitations: undefined,
          chatIds: undefined,
          failures: [],
          transcript: undefined,
          chatNames: undefined,
          live: undefined,
          error: cause instanceof Error ? cause.message : String(cause),
          opening: false
        })
      })
    return () => {
      stopStatus?.()
      stopFailures?.()
    }
  }, [wallet, adminOriginator, chain, host, attempt])

  const reopen = useCallback(() => {
    resetPlaygroundClient()
    setAttempt(n => n + 1)
  }, [])

  const reset = useCallback(async () => {
    setState(s => ({ ...s, opening: true, error: undefined }))
    await closePlaygroundClient()
    await deletePlaygroundData()
    setAttempt(n => n + 1)
  }, [])

  const onInvitationSettled = useCallback((listener: () => void) => settled.current(listener), [])

  return { ...state, reopen, reset, onInvitationSettled }
}
