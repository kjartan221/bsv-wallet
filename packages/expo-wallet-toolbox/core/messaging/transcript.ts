/**
 * The playground's record of what was said.
 *
 * `@bsv/group-messaging` stores group state, not messages. It hands each
 * message to a subscriber exactly once and keeps no log — deliberately, since
 * a transcript is the host's to own and a library has no business deciding how
 * long one lives. The playground previously kept them in component state,
 * which meant leaving a chat emptied it.
 *
 * This lives in the playground's own database, in a table the library would
 * never name, so clearing the playground clears the transcript with it and the
 * wallet's own tables are nowhere near it.
 */
import type * as SQLite from 'expo-sqlite'

export interface StoredMessage {
  chatId: string
  sender: string
  body: string
  /** Milliseconds since the epoch, as this device saw it. */
  at: number
}

export interface Transcript {
  append: (message: StoredMessage) => Promise<void>
  list: (chatId: string) => Promise<StoredMessage[]>
}

const TABLE = 'playground_messages'

/** Open the transcript, creating its table on first use. */
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

  return {
    append: async message => {
      await database.runAsync(`INSERT INTO ${TABLE} (chatId, sender, body, at) VALUES (?, ?, ?, ?)`, [
        message.chatId,
        message.sender,
        message.body,
        message.at
      ])
    },

    list: async chatId => {
      // `at` then `id`: two messages can share a millisecond, and arrival
      // order is the only tiebreak this device can honestly claim.
      const rows = (await database.getAllAsync(
        `SELECT chatId, sender, body, at FROM ${TABLE} WHERE chatId = ? ORDER BY at ASC, id ASC`,
        [chatId]
      )) as StoredMessage[]
      return rows
    }
  }
}
