/**
 * What this device calls a chat.
 *
 * The library has no rename. A chat carries the name the inviter put on the
 * wire and it is the same for everyone, which suits a group and suits nothing
 * else: a 1:1 arrives named after the person reading it, and a group someone
 * else named may mean nothing here.
 *
 * So a local override, stored beside the transcript in the playground's own
 * database. It never goes on the wire, the other side never learns it, and
 * clearing the playground clears it too.
 */
import type * as SQLite from 'expo-sqlite'

export interface ChatNames {
  /** Every local name, by chat id. Chats with no local name are absent. */
  all: () => Promise<Record<string, string>>
  /** Set a name, or clear it by passing something blank. */
  set: (chatId: string, name: string) => Promise<void>
}

const TABLE = 'playground_chat_names'

export async function makeChatNames(database: SQLite.SQLiteDatabase): Promise<ChatNames> {
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      chatId TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL
    );`
  )

  return {
    all: async () => {
      const rows = (await database.getAllAsync(`SELECT chatId, name FROM ${TABLE}`, [])) as {
        chatId: string
        name: string
      }[]
      return Object.fromEntries(rows.map(row => [row.chatId, row.name]))
    },

    set: async (chatId, name) => {
      const trimmed = name.trim()
      if (trimmed === '') {
        // Blank is not a name. Removing the row gives the derived one back,
        // rather than leaving an empty title on the chat.
        await database.runAsync(`DELETE FROM ${TABLE} WHERE chatId = ?`, [chatId])
        return
      }
      await database.runAsync(
        `INSERT INTO ${TABLE} (chatId, name) VALUES (?, ?)
         ON CONFLICT(chatId) DO UPDATE SET name = excluded.name`,
        [chatId, trimmed]
      )
    }
  }
}
