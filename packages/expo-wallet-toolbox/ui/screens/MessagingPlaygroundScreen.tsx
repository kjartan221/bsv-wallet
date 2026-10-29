/**
 * Messaging playground — the chat list.
 *
 * A test surface for `@bsv/group-messaging`, not a product one: it is behind
 * `EXPO_PUBLIC_MESSAGING_PLAYGROUND` and off in production until us-1 serves
 * the live socket (`__tests__/messagingPlaygroundShipGate.test.ts` pins that).
 *
 * States, in the order they are returned:
 *   • flag off            → hero, "not available" notice, inert CTA
 *   • opening             → spinner
 *   • failed to open      → error, retry, and the relay field so a bad host can
 *                           be corrected without leaving the screen
 *   • no chats            → empty state, New chat
 *   • chats               → list, New chat
 *
 * "New chat" picks one or more contacts and invites each with a shared chat id.
 * A group forms as the answers arrive — the first creates it, the rest are
 * added — so a chat can be live before everyone has joined.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, I18nManager, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../components/ui/PressableScale'
import { GroupedSection } from '../components/ui/GroupedList'
import ContactSigil from '../components/wallet/ContactSigil'
import { showToast } from '../components/ui/Toast'
import { showAlert } from '../components/ui/AlertCard'
import { useContactsStore } from '../hooks/useContactsStore'
import { useMessagingPlayground } from '../hooks/useMessagingPlayground'
import {
  DEFAULT_PLAYGROUND_MESSAGE_BOX_URL,
  messagingPlaygroundEnabled,
  readPlaygroundHost,
  writePlaygroundHost
} from '../../core/messaging/playground'
import { randomChatId } from '../../core/messaging/randomChatId'
import { abbreviateKey } from '../../core/pay/counterparty'
import type { ContactRow } from '../../core/contacts/contactsStore'

type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

interface PendingRow {
  inviteId: string
  direction: 'inbound' | 'outbound'
  /** Only an inbound key-package request is a decision; a welcome is joined. */
  kind: 'keyPackageRequest' | 'welcome'
  peer: string
  name: string
}

/** An invitation this device sent that the other side refused. */
interface DeclinedRow {
  inviteId: string
  peer: string
  name: string
}

interface ChatRow {
  chatId: string
  name: string
  memberCount: number
}

export function MessagingPlaygroundScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router, useFocusEffect } = loadExpoRouter()
  const { walletUserId, managers, selectedNetwork, adminOriginator } = useWallet()
  const contactsStore = useContactsStore()

  const enabled = messagingPlaygroundEnabled()
  const wallet = managers?.permissionsManager as object | undefined
  const [host, setHost] = useState<string>()
  const playground = useMessagingPlayground(enabled ? wallet : undefined, adminOriginator, selectedNetwork, host)

  const [chats, setChats] = useState<ChatRow[]>([])
  const [pending, setPending] = useState<PendingRow[]>([])
  const [declined, setDeclined] = useState<DeclinedRow[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [answering, setAnswering] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const contactsRef = useRef<ContactRow[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [chatName, setChatName] = useState('')
  const [inviting, setInviting] = useState(false)
  const [hostField, setHostField] = useState('')
  const [editingHost, setEditingHost] = useState(false)

  useEffect(() => {
    void readPlaygroundHost().then(saved => setHostField(saved))
  }, [])

  const refresh = useCallback(async () => {
    const client = playground.client
    if (client === undefined) return
    const groups = await client.listGroups()
    const local = (await playground.chatNames?.all()) ?? {}
    const rows = await Promise.all(
      groups.map(async group => {
        const info = await group.info()
        const others = info.members.filter(m => m.identityKey !== client.identityKey)
        // A 1:1's stored name is whatever the inviter called it, which for the
        // invitee is their own name. The other person is the honest title, and
        // it reads the same on both devices. A group's name is shared, so it
        // stands.
        // A name this device chose wins: it was chosen precisely because the
        // derived one was wrong here.
        const name =
          local[group.chatId] ??
          (others.length === 1
            ? (contactsRef.current.find(c => c.identityKey === others[0].identityKey)?.name ??
              abbreviateKey(others[0].identityKey))
            : (info.name ?? t('messaging_untitled_chat')))
        return { chatId: group.chatId, name, memberCount: info.members.length }
      })
    )
    setChats(rows)

    const [outbound, inbound] = await Promise.all([client.invites.list('outbound'), client.invites.list('inbound')])
    setPending(
      [...outbound, ...inbound].map(invite => ({
        inviteId: invite.inviteId,
        direction: invite.direction,
        kind: invite.kind,
        peer: invite.peer,
        name: invite.chatName ?? t('messaging_untitled_chat')
      }))
    )
  }, [playground.client, playground.chatNames, t])

  useEffect(() => {
    void refresh()
    const client = playground.client
    if (client === undefined) return
    // Membership and messages both change what the list shows.
    const stops = [
      client.on('membership', () => void refresh()),
      client.on('message', () => void refresh()),
      client.on('inviteReceived', () => void refresh()),
      // The join that creates a chat happens after welcomeReceived and emits
      // nothing of its own, so this is the only signal the list has.
      playground.onInvitationSettled(() => void refresh()),
      client.on('welcomeReceived', () => void refresh()),
      // The event carries no chat name; the inviter's own record has it.
      client.on('inviteDeclined', ({ inviteId, peer }) => {
        setDeclined(current =>
          current.some(row => row.inviteId === inviteId)
            ? current
            : [
                ...current,
                {
                  inviteId,
                  peer,
                  name: playground.chatIds?.nameFor(inviteId) ?? t('messaging_untitled_chat')
                }
              ]
        )
        void refresh()
      })
    ]
    return () => stops.forEach(stop => stop())
  }, [playground.client, playground.onInvitationSettled, refresh])

  /** Everyone picked, in order, so a group reads as who is in it. */
  const defaultChatName = useCallback(() => {
    const names = chosen.map(key => contacts.find(c => c.identityKey === key)?.name ?? abbreviateKey(key))
    return names.length === 0 ? t('messaging_untitled_chat') : names.join(', ')
  }, [chosen, contacts, t])

  const openPicker = useCallback(async () => {
    if (contactsStore === null || walletUserId === null) return
    setChosen([])
    setChatName('')
    setContacts(await contactsStore.listContacts(walletUserId))
    setPicking(true)
  }, [contactsStore, walletUserId])

  const reloadContacts = useCallback(async () => {
    if (contactsStore === null || walletUserId === null) return
    const rows = await contactsStore.listContacts(walletUserId)
    contactsRef.current = rows
    setContacts(rows)
  }, [contactsStore, walletUserId])

  // Every inbound row needs a name, not just the picker.
  useEffect(() => {
    void reloadContacts()
  }, [reloadContacts])

  // `/contact/add` is a route, not a modal, so returning from it refocuses this
  // screen rather than remounting it.
  useFocusEffect(
    useCallback(() => {
      void reloadContacts()
    }, [picking, reloadContacts])
  )

  const invite = useCallback(async () => {
    const client = playground.client
    const chatIds = playground.chatIds
    if (client === undefined || chatIds === undefined || chosen.length === 0) return
    setInviting(true)
    try {
      const chatId = randomChatId()
      const name = chatName.trim() === '' ? defaultChatName() : chatName.trim()
      for (const identityKey of chosen) {
        const inviteId = await client.invites.send(identityKey, { chatName: name })
        chatIds.remember(inviteId, { chatId, name })
      }
      setPicking(false)
      // Nothing else will reload this: the relay reports other people's
      // invitations, not our own, so without this the sender watches an empty
      // list and cannot tell a sent invitation from a lost one.
      await refresh()
      showToast(t('messaging_invites_sent', { count: chosen.length }), { type: 'success' })
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
    } finally {
      setInviting(false)
    }
  }, [playground.client, playground.chatIds, chosen, chatName, defaultChatName, refresh, t])

  const answer = useCallback(
    async (inviteId: string, accept: boolean) => {
      const invitations = playground.invitations
      if (invitations === undefined) return
      setAnswering(inviteId)
      try {
        await (accept ? invitations.accept(inviteId) : invitations.decline(inviteId))
        await refresh()
      } catch (cause) {
        // Logged as well as toasted: a toast is gone in three seconds, and a
        // swallowed failure here is indistinguishable from an invitation that
        // is simply still waiting.
        console.error('[messaging] answering invitation failed', cause)
        showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
      } finally {
        setAnswering(undefined)
      }
    },
    [playground.invitations, refresh]
  )

  const clearData = useCallback(async () => {
    const choice = await showAlert({
      title: t('messaging_reset_title'),
      message: t('messaging_reset_body'),
      buttons: [
        { text: t('messaging_reset'), key: 'confirm', style: 'destructive' },
        { text: t('cancel'), key: 'cancel', style: 'cancel' }
      ]
    })
    if (choice !== 'confirm') return
    try {
      await playground.reset()
      setChats([])
      setPending([])
      setDeclined([])
      showToast(t('messaging_reset_done'), { type: 'success' })
    } catch (cause) {
      console.error('[messaging] clearing the playground failed', cause)
      showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
    }
  }, [playground, t])

  const saveHost = useCallback(async () => {
    try {
      await writePlaygroundHost(hostField)
      const saved = await readPlaygroundHost()
      setHostField(saved)
      setHost(saved)
      setEditingHost(false)
      playground.reopen()
      showToast(t('messaging_relay_saved'), { type: 'success' })
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
    }
  }, [hostField, playground, t])

  const trouble = useMemo(
    () =>
      [
        ...declined.map(row => ({
          id: `declined:${row.inviteId}`,
          title: row.name,
          detail: t('messaging_declined')
        })),
        ...playground.failures.map((failure, index) => ({
          id: `failure:${failure.chatId}:${index}`,
          title: failure.stage,
          detail: failure.reason
        }))
      ].filter(item => !dismissed.includes(item.id)),
    [declined, playground.failures, dismissed, t]
  )

  const liveLabel = useMemo(() => {
    if (playground.live === undefined) return t('messaging_socket_unknown')
    return t(`messaging_socket_${playground.live.phase}`)
  }, [playground.live, t])

  // Only an inbound key-package request is a decision: a welcome is joined
  // automatically, and an invitation we sent is waiting on the other person.
  const needsAnswer = (invite: PendingRow) => invite.direction === 'inbound' && invite.kind === 'keyPackageRequest'

  /**
   * Who an invitation is with.
   *
   * An inbound one is named after the sender: the chat name it carries is the
   * inviter's name for us, so showing it shows the invitee their own name. An
   * outbound one keeps the name we gave the chat.
   */
  const titleFor = (invite: PendingRow) => {
    if (invite.direction === 'outbound') return invite.name
    return contacts.find(c => c.identityKey === invite.peer)?.name ?? abbreviateKey(invite.peer)
  }

  const Header = (
    <View style={[styles.header, { borderBottomColor: colors.separator }]}>
      <PressableScale
        onPress={() => router.back()}
        haptic="tap"
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel={t('go_back')}
      >
        <Ionicons
          name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'}
          size={24}
          color={colors.textSecondary}
        />
      </PressableScale>
      <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
        {t('messaging_title')}
      </Text>
      <PressableScale
        onPress={() => setEditingHost(true)}
        haptic="tap"
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel={t('messaging_relay_edit')}
      >
        <Ionicons name="server-outline" size={22} color={colors.textPrimary} />
      </PressableScale>
    </View>
  )

  const hostModal = (
    <Modal visible={editingHost} animationType="slide" transparent onRequestClose={() => setEditingHost(false)}>
      <View style={[styles.sheetBackdrop, { backgroundColor: colors.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: colors.backgroundElevated }]}>
          <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>{t('messaging_relay_title')}</Text>
          <Text style={[styles.sheetBody, { color: colors.textSecondary }]}>{t('messaging_relay_body')}</Text>
          <TextInput
            value={hostField}
            onChangeText={setHostField}
            placeholder={DEFAULT_PLAYGROUND_MESSAGE_BOX_URL}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.fillTertiary }]}
            accessibilityLabel={t('messaging_relay_title')}
          />
          <View style={styles.sheetActions}>
            <PressableScale
              onPress={() => setEditingHost(false)}
              haptic="tap"
              style={[styles.secondaryCta, { borderColor: colors.separator }]}
              accessibilityRole="button"
            >
              <Text style={[styles.secondaryCtaText, { color: colors.textPrimary }]}>{t('cancel')}</Text>
            </PressableScale>
            <PressableScale
              onPress={() => void saveHost()}
              haptic="confirm"
              style={[styles.cta, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Text style={[styles.ctaText, { color: colors.textOnAccent }]}>{t('save')}</Text>
            </PressableScale>
          </View>

          {/* A test surface accumulates half-finished exchanges, and starting
              from nothing is often the quickest way to re-run a case. Contacts
              live in the wallet's database, so they are not ours to clear. */}
          <PressableScale
            onPress={() => void clearData()}
            haptic="tap"
            style={styles.resetBtn}
            accessibilityRole="button"
          >
            <Text style={[styles.resetText, { color: colors.error }]}>{t('messaging_reset')}</Text>
          </PressableScale>
        </View>
      </View>
    </Modal>
  )

  const pickerModal = (
    <Modal visible={picking} animationType="slide" transparent onRequestClose={() => setPicking(false)}>
      <View style={[styles.sheetBackdrop, { backgroundColor: colors.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: colors.backgroundElevated }]}>
          <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>{t('messaging_new_chat')}</Text>
          <Text style={[styles.sheetBody, { color: colors.textSecondary }]}>{t('messaging_pick_body')}</Text>
          <TextInput
            value={chatName}
            onChangeText={setChatName}
            placeholder={defaultChatName()}
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.fillTertiary }]}
            accessibilityLabel={t('messaging_chat_name')}
          />
          <Text style={[styles.sheetBody, { color: colors.textTertiary }]}>{t('messaging_chat_name_hint')}</Text>

          <ScrollView style={styles.pickerList}>
            {contacts.length === 0 ? (
              <Text style={[styles.sheetBody, { color: colors.textTertiary }]}>{t('messaging_no_contacts')}</Text>
            ) : (
              contacts.map(contact => {
                const picked = chosen.includes(contact.identityKey)
                return (
                  <PressableScale
                    key={contact.identityKey}
                    onPress={() =>
                      setChosen(current =>
                        picked ? current.filter(k => k !== contact.identityKey) : [...current, contact.identityKey]
                      )
                    }
                    haptic="tap"
                    scaleTo={0.98}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: picked }}
                    accessibilityLabel={contact.name}
                  >
                    <View style={[styles.pickRow, { borderBottomColor: colors.separator }]}>
                      <ContactSigil identityKey={contact.identityKey} size={32} />
                      <View style={styles.pickText}>
                        <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                          {contact.name}
                        </Text>
                        <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                          {abbreviateKey(contact.identityKey)}
                        </Text>
                      </View>
                      <Ionicons
                        name={picked ? 'checkmark-circle' : 'ellipse-outline'}
                        size={22}
                        color={picked ? colors.accent : colors.textTertiary}
                      />
                    </View>
                  </PressableScale>
                )
              })
            )}
          </ScrollView>
          {/* The Contacts screen is only reachable from the Pay flow, so the
              picker carries its own way in rather than naming a path. */}
          <PressableScale
            onPress={() => router.push('/contact/add' as never)}
            haptic="tap"
            style={[styles.addContactBtn, { borderColor: colors.separator }]}
            accessibilityRole="button"
          >
            <Ionicons name="person-add-outline" size={18} color={colors.accent} />
            <Text style={[styles.addContactText, { color: colors.accent }]}>{t('contact_new_title')}</Text>
          </PressableScale>

          <View style={styles.sheetActions}>
            <PressableScale
              onPress={() => setPicking(false)}
              haptic="tap"
              style={[styles.secondaryCta, { borderColor: colors.separator }]}
              accessibilityRole="button"
            >
              <Text style={[styles.secondaryCtaText, { color: colors.textPrimary }]}>{t('cancel')}</Text>
            </PressableScale>
            <PressableScale
              onPress={() => void invite()}
              haptic="confirm"
              style={[styles.cta, { backgroundColor: chosen.length === 0 ? colors.fillSecondary : colors.accent }]}
              accessibilityRole="button"
              accessibilityState={{ disabled: chosen.length === 0 || inviting }}
            >
              {inviting ? (
                <ActivityIndicator color={colors.textOnAccent} />
              ) : (
                <Text style={[styles.ctaText, { color: colors.textOnAccent }]}>
                  {t('messaging_invite_count', { count: chosen.length })}
                </Text>
              )}
            </PressableScale>
          </View>
        </View>
      </View>
    </Modal>
  )

  if (!enabled) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.empty}>
          <Ionicons name="chatbubbles-outline" size={40} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('messaging_off_title')}</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{t('messaging_off_body')}</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {Header}

      <View style={[styles.statusRow, { borderBottomColor: colors.separator }]}>
        <Ionicons
          name={playground.live?.phase === 'subscribed' ? 'flash' : 'flash-off-outline'}
          size={14}
          color={playground.live?.phase === 'subscribed' ? colors.success : colors.textTertiary}
        />
        <Text style={[styles.statusText, { color: colors.textSecondary }]} numberOfLines={1}>
          {liveLabel}
        </Text>
      </View>

      {playground.opening ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : playground.error !== undefined ? (
        <View style={styles.empty}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.error} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('messaging_open_failed')}</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{playground.error}</Text>
          <PressableScale
            onPress={playground.reopen}
            haptic="tap"
            style={[styles.cta, { backgroundColor: colors.accent }]}
            accessibilityRole="button"
          >
            <Text style={[styles.ctaText, { color: colors.textOnAccent }]}>{t('retry')}</Text>
          </PressableScale>
        </View>
      ) : chats.length === 0 && pending.length === 0 && trouble.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="chatbubbles-outline" size={40} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('messaging_empty_title')}</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{t('messaging_empty_body')}</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {trouble.length > 0 && (
            <GroupedSection header={t('messaging_failed_title')}>
              {trouble.map(item => (
                <View key={item.id} style={[styles.row, { borderBottomColor: colors.separator }]}>
                  <View style={[styles.glyph, { backgroundColor: colors.fillTertiary }]}>
                    <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={2}>
                      {item.detail}
                    </Text>
                  </View>
                  <PressableScale
                    onPress={() => setDismissed(current => [...current, item.id])}
                    haptic="tap"
                    style={styles.dismissBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t('dismiss')}
                  >
                    <Ionicons name="close" size={18} color={colors.textTertiary} />
                  </PressableScale>
                </View>
              ))}
            </GroupedSection>
          )}

          {pending.length > 0 && (
            <GroupedSection header={t('messaging_pending_title')}>
              {pending.map(invite => (
                <View key={invite.inviteId} style={[styles.row, { borderBottomColor: colors.separator }]}>
                  <View style={[styles.glyph, { backgroundColor: colors.fillTertiary }]}>
                    <Ionicons name="hourglass-outline" size={18} color={colors.textSecondary} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {titleFor(invite)}
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                      {invite.direction === 'outbound' ? t('messaging_pending_sent') : t('messaging_pending_received')}
                    </Text>
                  </View>
                  {needsAnswer(invite) &&
                    (answering === invite.inviteId ? (
                      <ActivityIndicator color={colors.accent} />
                    ) : (
                      <View style={styles.answerRow}>
                        <PressableScale
                          onPress={() => void answer(invite.inviteId, false)}
                          haptic="tap"
                          style={[styles.answerBtn, { borderColor: colors.separator }]}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.answerText, { color: colors.textPrimary }]}>{t('reject')}</Text>
                        </PressableScale>
                        <PressableScale
                          onPress={() => void answer(invite.inviteId, true)}
                          haptic="confirm"
                          style={[styles.answerBtn, { backgroundColor: colors.accent }]}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.answerText, { color: colors.textOnAccent }]}>
                            {t('messaging_accept')}
                          </Text>
                        </PressableScale>
                      </View>
                    ))}
                </View>
              ))}
            </GroupedSection>
          )}

          <GroupedSection header={t('messaging_chats')}>
            {chats.map(chat => (
              <PressableScale
                key={chat.chatId}
                onPress={() =>
                  router.push({ pathname: '/messaging/[chatId]', params: { chatId: chat.chatId } } as never)
                }
                haptic="tap"
                scaleTo={0.98}
                accessibilityRole="button"
                accessibilityLabel={chat.name}
              >
                <View style={[styles.row, { borderBottomColor: colors.separator }]}>
                  <View style={[styles.glyph, { backgroundColor: colors.fillTertiary }]}>
                    <Ionicons name="chatbubbles" size={18} color={colors.textSecondary} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {chat.name}
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                      {t('messaging_member_count', { count: chat.memberCount })}
                    </Text>
                  </View>
                  <Ionicons
                    name={I18nManager.isRTL ? 'chevron-back' : 'chevron-forward'}
                    size={18}
                    color={colors.textTertiary}
                  />
                </View>
              </PressableScale>
            ))}
          </GroupedSection>
        </ScrollView>
      )}

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <PressableScale
          onPress={() => void openPicker()}
          haptic="confirm"
          style={[styles.cta, { backgroundColor: colors.accent }]}
          accessibilityRole="button"
          accessibilityState={{ disabled: playground.client === undefined }}
        >
          <Text style={[styles.ctaText, { color: colors.textOnAccent }]}>{t('messaging_new_chat')}</Text>
        </PressableScale>
      </View>

      {pickerModal}
      {hostModal}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600', flex: 1, textAlign: 'center' },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  statusText: { ...typography.caption1, flex: 1 },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  glyph: { width: 32, height: 32, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...typography.body },
  rowSub: { ...typography.footnote },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xxl },
  emptyTitle: { ...typography.headline, fontWeight: '600', textAlign: 'center' },
  emptyBody: { ...typography.subhead, textAlign: 'center' },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  cta: {
    minHeight: 48,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl
  },
  ctaText: { ...typography.headline, fontWeight: '600' },
  secondaryCta: {
    minHeight: 48,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    borderWidth: StyleSheet.hairlineWidth
  },
  secondaryCtaText: { ...typography.headline, fontWeight: '600' },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.xl,
    gap: spacing.md,
    maxHeight: '80%'
  },
  sheetTitle: { ...typography.title3, fontWeight: '600' },
  sheetBody: { ...typography.subhead },
  sheetActions: { flexDirection: 'row', gap: spacing.md },
  input: { ...typography.body, borderRadius: radii.md, paddingHorizontal: spacing.md, minHeight: 44 },
  resetBtn: { alignItems: 'center', paddingTop: spacing.lg, paddingBottom: spacing.xs },
  resetText: { ...typography.footnote, fontWeight: '600' },
  dismissBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  answerRow: { flexDirection: 'row', gap: spacing.sm },
  answerBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  answerText: { ...typography.footnote, fontWeight: '600' },
  addContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  addContactText: { ...typography.callout, fontWeight: '600' },
  pickerList: { maxHeight: 320 },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  pickText: { flex: 1, gap: 2 }
})
