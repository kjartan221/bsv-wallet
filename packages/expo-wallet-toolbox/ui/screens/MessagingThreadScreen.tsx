/**
 * Messaging playground — one chat.
 *
 * Bubbles and a composer. Mine on the trailing edge, everyone else's on the
 * leading edge, which `flexDirection: row-reverse` gets right under RTL without
 * naming a side.
 *
 * Messages live in memory for the session. The library stores group state, not
 * a transcript — it hands each message to a subscriber once and keeps no log —
 * so a transcript is the host's to keep, and a playground does not need one
 * that outlives the process.
 *
 * States: no chat id → error · chat missing → error · otherwise the thread,
 * empty or not.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  I18nManager,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../components/ui/PressableScale'
import { showToast } from '../components/ui/Toast'
import { showAlert } from '../components/ui/AlertCard'
import { useMessagingPlayground } from '../hooks/useMessagingPlayground'
import { messagingPlaygroundEnabled } from '../../core/messaging/playground'
import { abbreviateKey } from '../../core/pay/counterparty'
import { useContactsStore } from '../hooks/useContactsStore'
import { newMessageId, withMessageId } from '../../core/messaging/messageIds'
import type { MessageContent } from '@bsv/group-messaging'
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

interface Bubble {
  id: string
  sender: string
  mine: boolean
  content: MessageContent
  /** Reactions other people put on this message, by emoji. */
  reactions: string[]
  /** What this message answers, when it is a reply. */
  answering?: { sender: string; body: string }
}

export function MessagingThreadScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const params = useLocalSearchParams<{ chatId?: string }>()
  const chatId = typeof params.chatId === 'string' ? params.chatId : undefined
  const { managers, selectedNetwork, adminOriginator, walletUserId } = useWallet()
  const contactsStore = useContactsStore()

  const wallet = managers?.permissionsManager as object | undefined
  const playground = useMessagingPlayground(
    messagingPlaygroundEnabled() ? wallet : undefined,
    adminOriginator,
    selectedNetwork
  )

  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [title, setTitle] = useState('')
  const [members, setMembers] = useState(0)
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [renaming, setRenaming] = useState(false)
  const [nameField, setNameField] = useState('')
  const [localName, setLocalName] = useState<string>()
  const scroller = useRef<ScrollView>(null)
  const [keyboard, setKeyboard] = useState(0)
  const [replyTo, setReplyTo] = useState<Bubble>()
  const [asMarkdown, setAsMarkdown] = useState(false)

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const show = Keyboard.addListener(showEvt, e => {
      setKeyboard(e.endCoordinates?.height ?? 0)
      scroller.current?.scrollToEnd({ animated: true })
    })
    const hide = Keyboard.addListener(hideEvt, () => setKeyboard(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  const mine = playground.client?.identityKey

  const refreshInfo = useCallback(async () => {
    const client = playground.client
    if (client === undefined || chatId === undefined) return
    const group = await client.getGroup(chatId)
    if (group === undefined) return
    const info = await group.info()
    const mine = (await playground.chatNames?.all())?.[chatId]
    setLocalName(mine)
    if (mine !== undefined) {
      setTitle(mine)
      setMembers(info.members.length)
      return
    }
    const others = info.members.filter(m => m.identityKey !== client.identityKey)
    // Same rule as the chat list: a 1:1 is titled with the other person,
    // because its stored name is the inviter's name for us.
    setTitle(
      others.length === 1
        ? (contacts.find(c => c.identityKey === others[0].identityKey)?.name ?? abbreviateKey(others[0].identityKey))
        : (info.name ?? t('messaging_untitled_chat'))
    )
    setMembers(info.members.length)
  }, [playground.client, playground.chatNames, chatId, contacts, t])

  useEffect(() => {
    if (contactsStore === null || walletUserId === null) return
    void contactsStore.listContacts(walletUserId).then(setContacts)
  }, [contactsStore, walletUserId])

  useEffect(() => {
    void refreshInfo()
  }, [refreshInfo])

  const reload = useCallback(async () => {
    const transcript = playground.transcript
    const client = playground.client
    if (transcript === undefined || client === undefined || chatId === undefined) return
    try {
      const stored = await transcript.list(chatId)
      const byId = new Map(stored.map(m => [m.id, m]))

      // Reactions and read receipts are not messages in their own right: they
      // decorate or acknowledge one. Folding them in here keeps the list a
      // list of things somebody said.
      const reactions = new Map<string, string[]>()
      for (const m of stored) {
        const target = m.content.reaction?.reference
        if (m.content.type !== 'reaction' || target === undefined) continue
        const current = reactions.get(target) ?? []
        reactions.set(
          target,
          m.content.reaction?.action === 'removed'
            ? current.filter(e => e !== m.content.reaction?.content)
            : [...current, m.content.reaction?.content ?? '']
        )
      }

      setBubbles(
        stored
          .filter(m => m.content.type !== 'reaction' && m.content.type !== 'readReceipt')
          .map(m => {
            const answered =
              m.content.replyTo === undefined || m.content.replyTo === null ? undefined : byId.get(m.content.replyTo)
            return {
              id: m.id,
              sender: m.sender,
              mine: m.sender === client.identityKey,
              content: m.content,
              reactions: reactions.get(m.id) ?? [],
              ...(answered === undefined
                ? {}
                : { answering: { sender: answered.sender, body: answered.content.body ?? '' } })
            }
          })
      )
    } catch (cause) {
      // A handle left over from a cleared or reopened playground. Reported
      // rather than thrown: an unreadable transcript must not take the chat
      // down with it, and a bare rejection says nothing about where it came
      // from.
      console.error('[messaging] reading the transcript failed', cause)
      showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
    }
  }, [playground.transcript, playground.client, chatId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Opening the chat is the event a read receipt reports. Sent once per visit
  // and never rendered: it acknowledges, it does not say anything.
  useEffect(() => {
    const client = playground.client
    if (client === undefined || chatId === undefined) return
    void (async () => {
      try {
        const group = await client.getGroup(chatId)
        await group?.sendContent(withMessageId({ v: 1, type: 'readReceipt', body: '' }, newMessageId()))
      } catch (cause) {
        // Nothing depends on it arriving, so a failure is worth seeing and
        // not worth interrupting anyone over.
        console.error('[messaging] read receipt failed', cause)
      }
    })()
  }, [playground.client, chatId])

  useEffect(() => {
    const client = playground.client
    if (client === undefined || chatId === undefined) return
    const stops = [
      // The hook writes every message to the transcript, including ones that
      // arrive while this screen is closed; re-reading keeps one source.
      client.on('message', payload => {
        if (payload.chatId === chatId) void reload()
      }),
      client.on('membership', payload => {
        if (payload.chatId === chatId) void refreshInfo()
      })
    ]
    return () => stops.forEach(stop => stop())
  }, [playground.client, chatId, refreshInfo, reload])

  const send = useCallback(async () => {
    const client = playground.client
    const body = draft.trim()
    if (client === undefined || chatId === undefined || body === '') return
    setSending(true)
    try {
      const group = await client.getGroup(chatId)
      if (group === undefined) throw new Error(t('messaging_chat_missing'))

      // Built here rather than through sendText/sendReply, because every
      // message needs the id a later reply or reaction will point at, and the
      // typed helpers do not carry one.
      const id = newMessageId()
      const base: MessageContent = asMarkdown
        ? { v: 1, type: 'markdown', body, markdown: body }
        : { v: 1, type: 'text', body }
      const content = withMessageId(replyTo === undefined ? base : { ...base, type: 'reply', replyTo: replyTo.id }, id)
      await group.sendContent(content)
      setDraft('')
      setReplyTo(undefined)
      // MLS never hands a sender its own message back, so the author's copy is
      // the host's to write down.
      await playground.transcript?.append({ chatId, id, sender: mine ?? '', at: Date.now(), content })
      await reload()
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
    } finally {
      setSending(false)
    }
  }, [playground.client, playground.transcript, chatId, draft, mine, reload, replyTo, asMarkdown, t])

  /** A reaction is its own message, pointing at the one it decorates. */
  const react = useCallback(
    async (bubble: Bubble, emoji: string) => {
      const client = playground.client
      if (client === undefined || chatId === undefined) return
      try {
        const group = await client.getGroup(chatId)
        if (group === undefined) throw new Error(t('messaging_chat_missing'))
        const id = newMessageId()
        const content = withMessageId(
          {
            v: 1,
            type: 'reaction',
            body: emoji,
            reaction: { reference: bubble.id, action: 'added', content: emoji, schema: 'unicode' }
          },
          id
        )
        await group.sendContent(content)
        await playground.transcript?.append({ chatId, id, sender: mine ?? '', at: Date.now(), content })
        await reload()
      } catch (cause) {
        console.error('[messaging] reacting failed', cause)
        showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
      }
    },
    [playground.client, playground.transcript, chatId, mine, reload, t]
  )

  const onBubble = useCallback(
    async (bubble: Bubble) => {
      const choice = await showAlert({
        title: bubble.content.body ?? '',
        buttons: [
          { text: t('messaging_reply'), key: 'reply' },
          { text: `${t('messaging_react')} 👍`, key: '👍' },
          { text: `${t('messaging_react')} 🎉`, key: '🎉' },
          { text: t('cancel'), key: 'cancel', style: 'cancel' }
        ]
      })
      if (choice === 'reply') setReplyTo(bubble)
      else if (choice === '👍' || choice === '🎉') await react(bubble, choice)
    },
    [react, t]
  )

  const subtitle = useMemo(() => t('messaging_member_count', { count: members }), [members, t])

  const saveName = useCallback(async () => {
    if (chatId === undefined) return
    try {
      await playground.chatNames?.set(chatId, nameField)
      setRenaming(false)
      await refreshInfo()
    } catch (cause) {
      console.error('[messaging] renaming the chat failed', cause)
      showToast(cause instanceof Error ? cause.message : String(cause), { type: 'error' })
    }
  }, [playground.chatNames, chatId, nameField, refreshInfo])

  const renameSheet = (
    <Modal visible={renaming} animationType="slide" transparent onRequestClose={() => setRenaming(false)}>
      <View style={[styles.sheetBackdrop, { backgroundColor: colors.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: colors.backgroundElevated }]}>
          <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>{t('messaging_chat_name')}</Text>
          <Text style={[styles.sheetBody, { color: colors.textSecondary }]}>{t('messaging_rename_hint')}</Text>
          <TextInput
            value={nameField}
            onChangeText={setNameField}
            placeholder={title}
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.fillTertiary }]}
            accessibilityLabel={t('messaging_chat_name')}
          />
          <View style={styles.sheetActions}>
            <PressableScale
              onPress={() => setRenaming(false)}
              haptic="tap"
              style={[styles.secondaryCta, { borderColor: colors.separator }]}
              accessibilityRole="button"
            >
              <Text style={[styles.secondaryCtaText, { color: colors.textPrimary }]}>{t('cancel')}</Text>
            </PressableScale>
            <PressableScale
              onPress={() => void saveName()}
              haptic="confirm"
              style={[styles.cta, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Text style={[styles.ctaText, { color: colors.textOnAccent }]}>{t('save')}</Text>
            </PressableScale>
          </View>
        </View>
      </View>
    </Modal>
  )

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
      {/* The title is the rename control. The library has no rename, so this
          name never leaves the device. */}
      <PressableScale
        onPress={() => {
          setNameField(localName ?? '')
          setRenaming(true)
        }}
        haptic="tap"
        style={styles.headerText}
        accessibilityRole="button"
        accessibilityLabel={t('messaging_chat_name')}
      >
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {title === '' ? t('messaging_untitled_chat') : title}
        </Text>
        <Text style={[styles.headerSub, { color: colors.textSecondary }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </PressableScale>
      <View style={styles.headerBtn} />
    </View>
  )

  if (chatId === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.empty}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.error} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('messaging_chat_missing')}</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {Header}
      {renameSheet}

      {playground.opening ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : bubbles.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="chatbubble-ellipses-outline" size={40} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('messaging_thread_empty_title')}</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{t('messaging_thread_empty_body')}</Text>
        </View>
      ) : (
        <ScrollView
          ref={scroller}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        >
          {bubbles.map(bubble => (
            <PressableScale
              key={bubble.id}
              onLongPress={() => void onBubble(bubble)}
              haptic="tap"
              scaleTo={0.99}
              style={[styles.bubbleRow, bubble.mine && styles.bubbleRowMine]}
              accessibilityRole="button"
              accessibilityLabel={bubble.content.body ?? t('messaging_untitled_chat')}
            >
              <View
                style={[
                  styles.bubble,
                  {
                    // Mine is a filled surface, theirs a raised one. Both are
                    // translucent or themed tokens, so they invert with the
                    // palette; `accent` is the CTA colour — black in light,
                    // white in dark — and a slab of it reads as a button.
                    backgroundColor: bubble.mine ? colors.fill : colors.surfaceRaised,
                    borderColor: bubble.mine ? colors.separator : colors.surfaceRaisedBorder
                  },
                  bubble.mine ? styles.bubbleMine : styles.bubbleTheirs
                ]}
              >
                {!bubble.mine && (
                  <Text style={[styles.bubbleWho, { color: colors.textTertiary }]} numberOfLines={1}>
                    {contacts.find(c => c.identityKey === bubble.sender)?.name ?? abbreviateKey(bubble.sender)}
                  </Text>
                )}

                {bubble.answering !== undefined && (
                  <View style={[styles.quote, { borderLeftColor: colors.separator }]}>
                    <Text style={[styles.quoteWho, { color: colors.textTertiary }]} numberOfLines={1}>
                      {contacts.find(c => c.identityKey === bubble.answering?.sender)?.name ??
                        abbreviateKey(bubble.answering.sender)}
                    </Text>
                    <Text style={[styles.quoteBody, { color: colors.textTertiary }]} numberOfLines={2}>
                      {bubble.answering.body}
                    </Text>
                  </View>
                )}

                {/* The library's rule: anything unknown must still surface its
                    body, so an older build degrades instead of showing
                    nothing. Markdown is shown as its plain-text fallback —
                    rendering it properly is a renderer, not a playground. */}
                <Text style={[styles.bubbleBody, { color: colors.textPrimary }]}>{bubble.content.body ?? ''}</Text>

                {(bubble.content.attachments ?? []).map(attachment => (
                  <Text
                    key={attachment.contentHash}
                    style={[styles.bubbleMeta, { color: colors.textTertiary }]}
                    numberOfLines={1}
                  >
                    {`📎 ${attachment.filename ?? attachment.mimeType}`}
                  </Text>
                ))}

                {bubble.content.type === 'markdown' && (
                  <Text style={[styles.bubbleMeta, { color: colors.textTertiary }]}>
                    {t('messaging_markdown_sent')}
                  </Text>
                )}

                {bubble.reactions.length > 0 && (
                  <Text style={[styles.bubbleReactions, { color: colors.textSecondary }]}>
                    {bubble.reactions.join(' ')}
                  </Text>
                )}
              </View>
            </PressableScale>
          ))}
        </ScrollView>
      )}

      {replyTo !== undefined && (
        <View style={[styles.replyBar, { marginBottom: keyboard > 0 ? 0 : undefined }]}>
          <Text style={[styles.replyBarText, { color: colors.textSecondary }]} numberOfLines={1}>
            {`${t('messaging_replying_to')}: ${replyTo.content.body ?? ''}`}
          </Text>
          <PressableScale
            onPress={() => setReplyTo(undefined)}
            haptic="tap"
            style={styles.modeBtn}
            accessibilityRole="button"
            accessibilityLabel={t('cancel')}
          >
            <Ionicons name="close" size={18} color={colors.textTertiary} />
          </PressableScale>
        </View>
      )}

      <View
        style={[
          styles.composer,
          {
            borderTopColor: colors.separator,
            // Lifted by the keyboard's own height rather than by
            // KeyboardAvoidingView: Android 15 draws edge-to-edge, so
            // adjustResize no longer shrinks the window for it to react to.
            // Same approach as Sheet.tsx.
            marginBottom: keyboard,
            paddingBottom: keyboard > 0 ? spacing.md : Math.max(insets.bottom, spacing.md)
          }
        ]}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t('messaging_composer_placeholder')}
          placeholderTextColor={colors.textTertiary}
          multiline
          style={[styles.composerInput, { color: colors.textPrimary, backgroundColor: colors.fillTertiary }]}
          accessibilityLabel={t('messaging_composer_placeholder')}
        />
        <PressableScale
          onPress={() => setAsMarkdown(current => !current)}
          haptic="tap"
          style={[styles.modeBtn, asMarkdown && { backgroundColor: colors.fillTertiary }]}
          accessibilityRole="button"
          accessibilityLabel={t('messaging_markdown_toggle')}
          accessibilityState={{ selected: asMarkdown }}
        >
          <Ionicons name="logo-markdown" size={18} color={asMarkdown ? colors.accent : colors.textTertiary} />
        </PressableScale>
        <PressableScale
          onPress={() => void send()}
          haptic="confirm"
          style={[styles.sendBtn, { backgroundColor: draft.trim() === '' ? colors.fillSecondary : colors.accent }]}
          accessibilityRole="button"
          accessibilityLabel={t('messaging_send')}
          accessibilityState={{ disabled: draft.trim() === '' || sending }}
        >
          {sending ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Ionicons name="arrow-up" size={20} color={colors.textOnAccent} />
          )}
        </PressableScale>
      </View>
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
  headerText: { flex: 1, alignItems: 'center', gap: 2 },
  headerTitle: { ...typography.headline, fontWeight: '600' },
  headerSub: { ...typography.caption1 },
  list: { flex: 1 },
  listContent: { padding: spacing.lg, gap: spacing.sm },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { flexDirection: 'row-reverse' },
  bubble: {
    maxWidth: '80%',
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2
  },
  bubbleMine: { borderBottomRightRadius: radii.sm },
  bubbleTheirs: { borderBottomLeftRadius: radii.sm, borderWidth: StyleSheet.hairlineWidth },
  bubbleWho: { ...typography.caption2 },
  bubbleBody: { ...typography.body },
  bubbleMeta: { ...typography.caption2, opacity: 0.8 },
  bubbleReactions: { ...typography.caption1 },
  quote: { borderLeftWidth: 2, paddingLeft: spacing.sm, gap: 1, opacity: 0.9 },
  quoteWho: { ...typography.caption2, fontWeight: '600' },
  quoteBody: { ...typography.caption2 },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  replyBarText: { ...typography.caption1, flex: 1 },
  modeBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xxl },
  emptyTitle: { ...typography.headline, fontWeight: '600', textAlign: 'center' },
  emptyBody: { ...typography.subhead, textAlign: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, padding: spacing.lg, gap: spacing.md },
  sheetTitle: { ...typography.headline, fontWeight: '600' },
  sheetBody: { ...typography.subhead },
  sheetActions: { flexDirection: 'row', gap: spacing.sm },
  input: {
    ...typography.body,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44
  },
  cta: { flex: 1, borderRadius: radii.pill, paddingVertical: spacing.md, alignItems: 'center' },
  ctaText: { ...typography.callout, fontWeight: '600' },
  secondaryCta: {
    flex: 1,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth
  },
  secondaryCtaText: { ...typography.callout, fontWeight: '600' },
  composerInput: {
    ...typography.body,
    flex: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
    maxHeight: 120
  },
  sendBtn: { width: 44, height: 44, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' }
})
