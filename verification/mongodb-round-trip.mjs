import { readFileSync } from 'node:fs'

/**
 * A round trip added to the MongoDB scenarios (only in .work/): what is stored is what is read, types included; a
 * change writes only its fields and keeps those the models do not know; and refusals are domain errors.
 */
export const roundTrip = (shop) => ({
  path: 'test/round-trip.test.ts',
  content: shop
    ? `import { expect, it } from 'vitest'
import { useTestDatabase } from './database.js'
import { addCustomer, addOrder, newCustomer, newOrder, newProduct } from './factories.js'

const uow = useTestDatabase()

it('keeps every value', async () => {
  const product = await uow().products.insert(newProduct(1))
  expect(await uow().products.READ_ID(product.id)).toMatchObject(newProduct(1))
  const customer = await uow().customers.insert(newCustomer(1))
  expect(await uow().customers.READ_ID(customer.id)).toMatchObject(newCustomer(1))
  const order = await addOrder(uow(), 2)
  const found = (await uow().orders.READ_ID(order.id))!
  expect(found.lines[0]).toMatchObject(newOrder(2).lines[0])
  expect(found.lines[0]._id).toMatch(/^[0-9a-f]{24}$/)
})

it('changes only what is different, and keeps what it does not know', async () => {
  const { id } = await addCustomer(uow(), 1)
  const stored = () => uow().db.connection.collection('customers').findOne({ email: 'email-1' })
  await uow().db.connection.collection('customers').updateOne({ email: 'email-1' }, { $set: { unknown: 1, 'address.unknown': 2 } })
  const one = (await uow().customers.READ_ID(id))!
  const other = (await uow().customers.READ_ID(id))!
  one.name = 'one'
  other.level = 'gold'
  other.address!.city = 'Madrid'
  other.passwordHash = null
  await uow().customers.update(one)
  await uow().customers.update(other)
  expect(await stored()).toMatchObject({ name: 'one', level: 'gold', unknown: 1, address: { city: 'Madrid', unknown: 2 } })
  expect(await stored()).not.toHaveProperty('passwordHash')
})

it('refuses repeated and wrong values', async () => {
  await addCustomer(uow(), 1)
  await expect(uow().customers.insert(newCustomer(1))).rejects.toMatchObject({ name: 'ConflictError' })
  const wrong = newCustomer(2)
  wrong.address = { street: 's' } as never
  await expect(uow().customers.insert(wrong)).rejects.toMatchObject({ name: 'ValidationFailedError' })
  expect(await uow().customers.READ_ID('not an identifier')).toBeNull()
})
TRANSACTION
it('creates nothing in the database', async () => {
  const { createDatabase } = await import('../src/database.js')
  await uow().db.connection.dropDatabase()
  const db = await createDatabase(process.env.TEST_DATABASE_URL)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(await db.connection.listCollections()).toEqual([])
  await db.connection.close()
})
`
    : `import { expect, it } from 'vitest'
import { useTestDatabase } from './database.js'
import { addPatient, addRoom, newPatient, newRoom } from './factories.js'

const uow = useTestDatabase()

// The collections as their own script creates them, with their validators
const SCRIPT = ${JSON.stringify(readFileSync(new URL('./mongodb/clinic.js', import.meta.url), 'utf8'))}

async function original(): Promise<void> {
  const { connection } = uow().db
  await connection.dropDatabase()
  const work: (() => Promise<unknown>)[] = []
  const collection = (name: string) => ({
    createIndex: (keys: never, options: never) => work.push(() => connection.collection(name).createIndex(keys, options ?? {})),
  })
  const db = {
    createCollection: (name: string, options: never) => work.push(() => connection.createCollection(name, options)),
    getCollection: collection,
    patients: collection('patients'),
  }
  new Function('db', SCRIPT)(db)
  for (const step of work) await step()
}

it('fits the validators of the collections', async () => {
  await original()
  const patient = await uow().patients.insert(newPatient(1))
  const found = (await uow().patients.findById(patient.id))!
  expect(found).toMatchObject(newPatient(1))
  const room = await addRoom(uow(), 1)
  expect(await uow().rooms.findById(room.id)).toMatchObject(newRoom(1))
  found.weight = 70
  found.balance = null
  found.visits = 3
  found.contacts.push({ kind: 'email', value: 'a@b.c' })
  room.beds = 4
  await uow().patients.update(found)
  await uow().rooms.update(room)
  expect(await uow().patients.findById(patient.id)).toMatchObject({ weight: 70, balance: null, visits: 3, contacts: found.contacts })
  expect((await uow().rooms.findById(room.id))?.beds).toBe(4)
  await expect(uow().patients.insert(newPatient(1))).rejects.toMatchObject({ name: 'ConflictError' })
  await addPatient(uow(), 2)
  // What only the validator of the collection knows is refused too
  await uow().db.connection.db!.command({ collMod: 'rooms', validator: { beds: { $lt: 10 } } })
  room.beds = 50
  await expect(uow().rooms.update(room)).rejects.toMatchObject({ name: 'ConflictError' })
})
`,
})

const TRANSACTION = `
it('undoes a transaction that fails', async () => {
  await expect(
    uow().transaction(async (inside) => {
      await inside.customers.insert(newCustomer(1))
      throw new Error('stop')
    }),
  ).rejects.toThrow('stop')
  expect(await uow().db.connection.collection('customers').countDocuments()).toBe(0)
})
`

export function withRoundTrip(files, settings, code) {
  const test = roundTrip(code.endsWith('shop.ts'))
  const content = test.content
    .replaceAll('READ_ID', settings.verbs === 'get' ? 'getById' : 'findById')
    .replace('TRANSACTION', (settings.transactions ?? 'operation') === 'operation' ? TRANSACTION : '')
    .replaceAll("import('../src/database.js')", "import('../src/database.js')")
  return [...files, { ...test, content }]
}
