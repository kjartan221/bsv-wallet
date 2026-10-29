/**
 * The playground's record of what was said.
 *
 * `@bsv/group-messaging` stores group state, not messages. It hands each one
 * to a subscriber exactly once and keeps no log — deliberately, since a
 * transcript is the host's to own and a library has no business deciding how
 * long one lives.
 *
 * The whole content envelope is kept, not just the text. A reply, a reaction
 * or a type this build has never heard of is still a message, and the library
 * is explicit that an unknown `type` must still surface its `body` so older
 * clients degrade instead of showing nothing.
 *
 * Each row carries an id, because the library has none. `replyTo` and a
 * reaction's `reference` are opaque strings the application defines, so the
 * host mints one per message and everything that points at a message uses it.
 *
 * It lives in the playground's own database, in a table the library would
 * never name, so clearing the playground clears the transcript with it.
 */
import type * as SQLite from 'expo-sqlite'
import type { MessageContent } from '@bsv/group-messaging'

export interface StoredMessage {
  chatId: string
  /** This host's id for the message; what a reply or reaction references. */
  id: string
  sender: string
  /** Milliseconds since the epoch, as this device saw it. */
  at: number
  content: MessageContent
}

export interface Transcript {
  append: (message: StoredMessage) => Promise<void>
  list: (chatId: string) => Promise<StoredMessage[]>
}

const TABLE = 'playground_messages'

/** Columns added after the first version shipped, in the order they appeared. */
const ADDED = [
  { name: 'messageId', type: 'TEXT' },
  { name: 'content', type: 'TEXT' }
]

async function addMissingColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  const columns = (await database.getAllAsync(`PRAGMA table_info(${TABLE})`, [])) as { name: string }[]
  const present = new Set(columns.map(c => c.name))
  for (const column of ADDED) {
    // Rows written by an earlier build are real messages; growing the table
    // keeps them rather than starting the transcript over.
    if (!present.has(column.name)) {
      await database.execAsync(`ALTER TABLE ${TABLE} ADD COLUMN ${column.name} ${column.type}`)
    }
  }
}

/** Open the transcript, creating or growing its table as needed. */
export async function makeTranscript(database: SQLite.SQLiteDatabase): Promise<Transcript> {
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_chat ON ${TABLE}(chatId, at);`
  )
  await addMissingColumns(database)

  return {
    append: async message => {
      await database.runAsync(
        `INSERT INTO ${TABLE} (chatId, messageId, sender, body, at, content) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          message.chatId,
          message.id,
          message.sender,
          // `body` stays populated so a row remains readable to anything that
          // only knows the first schema.
          message.content.body ?? '',
          message.at,
          JSON.stringify(message.content)
        ]
      )
    },

    list: async chatId => {
      // `at` then `id`: two messages can share a millisecond, and arrival
      // order is the only tiebreak this device can honestly claim.
      const rows = (await database.getAllAsync(
        `SELECT id, chatId, messageId, sender, body, at, content FROM ${TABLE} WHERE chatId = ? ORDER BY at ASC, id ASC`,
        [chatId]
      )) as {
        id: number
        chatId: string
        messageId: string | null
        sender: string
        body: string
        at: number
        content: string | null
      }[]

      return rows.map(row => ({
        chatId: row.chatId,
        // A row from before ids existed still needs one, or nothing can
        // reference it and React has no stable key for it.
        id: row.messageId ?? `legacy-${row.id}`,
        sender: row.sender,
        at: row.at,
        content: parseContent(row.content, row.body)
      }))
    }
  }
}

function parseContent(stored: string | null, body: string): MessageContent {
  if (stored === null) return { v: 1, type: 'text', body }
  try {
    return JSON.parse(stored) as MessageContent
  } catch {
    // Unreadable JSON is still a message that was received; the body column
    // is the fallback the library's own degradation rule relies on.
    return { v: 1, type: 'text', body }
  }
}
