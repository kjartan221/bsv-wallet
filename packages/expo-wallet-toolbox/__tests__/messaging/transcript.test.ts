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

    await transcript.append({ chatId: 'c1', id: 'm-c1-2', sender: '02aa', at: 2, content: { v: 1, type: 'text', body: 'second' } })
    await transcript.append({ chatId: 'c1', id: 'm-c1-1', sender: '02me', at: 1, content: { v: 1, type: 'text', body: 'first' } })

    expect((await transcript.list('c1')).map(m => m.content.body)).toEqual(['first', 'second'])
  })

  it('keeps chats apart', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', id: 'm-c1-1', sender: '02aa', at: 1, content: { v: 1, type: 'text', body: 'mine' } })
    await transcript.append({ chatId: 'c2', id: 'm-c2-1', sender: '02bb', at: 1, content: { v: 1, type: 'text', body: 'theirs' } })

    expect((await transcript.list('c1')).map(m => m.content.body)).toEqual(['mine'])
    expect((await transcript.list('c2')).map(m => m.content.body)).toEqual(['theirs'])
  })

  it('orders by arrival when two share a millisecond', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', id: 'm-c1-7', sender: '02aa', at: 7, content: { v: 1, type: 'text', body: 'one' } })
    await transcript.append({ chatId: 'c1', id: 'm-c1-7', sender: '02aa', at: 7, content: { v: 1, type: 'text', body: 'two' } })
    await transcript.append({ chatId: 'c1', id: 'm-c1-7', sender: '02aa', at: 7, content: { v: 1, type: 'text', body: 'three' } })

    expect((await transcript.list('c1')).map(m => m.content.body)).toEqual(['one', 'two', 'three'])
  })

  it('records who sent each message, so bubbles can take a side', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', id: 'm-c1-1', sender: '02me', at: 1, content: { v: 1, type: 'text', body: 'hello' } })

    expect((await transcript.list('c1'))[0].sender).toBe('02me')
  })

  it('survives being opened twice over the same database', async () => {
    const { db } = database()
    await makeTranscript(db as never)
    const second = await makeTranscript(db as never)

    // Every app start calls this; a CREATE that was not IF NOT EXISTS would
    // throw on the second launch and take the playground with it.
    await second.append({ chatId: 'c1', id: 'm-c1-1', sender: '02me', at: 1, content: { v: 1, type: 'text', body: 'still here' } })
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

describe('the whole envelope', () => {
  it('keeps the content it was given, whatever the type', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({
      chatId: 'c1',
      id: 'm1',
      sender: '02aa',
      at: 1,
      content: { v: 1, type: 'markdown', body: 'hi', markdown: '**hi**' }
    })

    const [stored] = await transcript.list('c1')
    expect(stored.content).toEqual({ v: 1, type: 'markdown', body: 'hi', markdown: '**hi**' })
  })

  it('keeps a reply pointing at what it answers', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({
      chatId: 'c1',
      id: 'm2',
      sender: '02aa',
      at: 2,
      content: { v: 1, type: 'reply', body: 'agreed', replyTo: 'm1' }
    })

    expect((await transcript.list('c1'))[0].content.replyTo).toBe('m1')
  })

  it('gives each message the id a reply or reaction can name', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({ chatId: 'c1', id: 'm1', sender: '02aa', at: 1, content: { v: 1, type: 'text', body: 'x' } })

    // The library has no message id of its own, so the host mints one and
    // everything that references a message uses it.
    expect((await transcript.list('c1'))[0].id).toBe('m1')
  })

  it('survives content it cannot make sense of', async () => {
    const { db } = database()
    const transcript = await makeTranscript(db as never)

    await transcript.append({
      chatId: 'c1',
      id: 'm1',
      sender: '02aa',
      at: 1,
      content: { v: 99, type: 'somethingNew', body: 'shown anyway' }
    })

    const [stored] = await transcript.list('c1')
    expect(stored.content.type).toBe('somethingNew')
    expect(stored.content.body).toBe('shown anyway')
  })

  it('reads rows written before the envelope was stored', async () => {
    const { db } = database()
    // The first schema had no id and no content, only a body. Those rows are
    // real messages and must not vanish when the table grows.
    await db.execAsync(
      `CREATE TABLE playground_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT NOT NULL, sender TEXT NOT NULL,
        body TEXT NOT NULL, at INTEGER NOT NULL);`
    )
    await db.runAsync('INSERT INTO playground_messages (chatId, sender, body, at) VALUES (?, ?, ?, ?)', [
      'c1',
      '02aa',
      'from before',
      1
    ])

    const transcript = await makeTranscript(db as never)

    const [stored] = await transcript.list('c1')
    expect(stored.content.body).toBe('from before')
    expect(stored.content.type).toBe('text')
    // It still needs an id: nothing can reply to a message without one, and
    // React has no stable key for it.
    expect(typeof stored.id).toBe('string')
    expect(stored.id.length).toBeGreaterThan(0)
  })
})
