/**
 * The playground's transcript, against a real SQLite.
 *
 * `@bsv/group-messaging` stores group state, not messages: it hands each one
 * to a subscriber exactly once and keeps no log. So a chat that is left and
 * reopened shows nothing unless the host wrote the messages down — which the
 * playground was not doing, and which made every chat look empty on return.
 *
 * `node:sqlite` rather than a hand-written fake. A fake that filters rows in
 * JavaScript passes whatever the WHERE clause says, including nothing at all,
 * which is exactly the bug such a test is supposed to catch. The real engine
 * runs the real SQL. It prints an experimental warning; that is expected.
 */
import { DatabaseSync } from 'node:sqlite'
import { makeTranscript } from '../../core/messaging/transcript'

/** `expo-sqlite`'s shape over `node:sqlite`, which is all the transcript uses. */
function database() {
  const db = new DatabaseSync(':memory:')
  const statements: string[] = []
  return {
    statements,
    db: {
      execAsync: async (sql: string) => {
        statements.push(sql)
        db.exec(sql)
      },
      runAsync: async (sql: string, params: unknown[] = []) => {
        statements.push(sql)
        db.prepare(sql).run(...(params as never[]))
      },
      getAllAsync: async (sql: string, params: unknown[] = []) => {
        statements.push(sql)
        return db.prepare(sql).all(...(params as never[]))
      }
    }
  }
}

describe('the transcript', () => {
  it('gives back what was written, oldest first', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', sender: '02aa', body: 'second', at: 2 })
    await transcript.append({ chatId: 'c1', sender: '02me', body: 'first', at: 1 })

    expect((await transcript.list('c1')).map(m => m.body)).toEqual(['first', 'second'])
  })

  it('keeps chats apart', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', sender: '02aa', body: 'mine', at: 1 })
    await transcript.append({ chatId: 'c2', sender: '02bb', body: 'theirs', at: 1 })

    expect((await transcript.list('c1')).map(m => m.body)).toEqual(['mine'])
    expect((await transcript.list('c2')).map(m => m.body)).toEqual(['theirs'])
  })

  it('orders by arrival when two share a millisecond', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', sender: '02aa', body: 'one', at: 7 })
    await transcript.append({ chatId: 'c1', sender: '02aa', body: 'two', at: 7 })
    await transcript.append({ chatId: 'c1', sender: '02aa', body: 'three', at: 7 })

    expect((await transcript.list('c1')).map(m => m.body)).toEqual(['one', 'two', 'three'])
  })

  it('records who sent each message, so bubbles can take a side', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', sender: '02me', body: 'hello', at: 1 })

    expect((await transcript.list('c1'))[0].sender).toBe('02me')
  })

  it('survives being opened twice over the same database', async () => {
    const { db } = database()
    await makeTranscript(db as never)
    const second = await makeTranscript(db as never)

    // Every app start calls this; a CREATE that was not IF NOT EXISTS would
    // throw on the second launch and take the playground with it.
    await second.append({ chatId: 'c1', sender: '02me', body: 'still here', at: 1 })
    expect(await second.list('c1')).toHaveLength(1)
  })

  it('is empty for a chat nothing was said in', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    expect(await transcript.list('never-used')).toEqual([])
  })

  it('uses a table of its own, not one the library would pick', async () => {
    const { db, statements } = database()

    await makeTranscript(db as never)

    expect(statements.some(s => s.includes('playground_messages'))).toBe(true)
  })
})
