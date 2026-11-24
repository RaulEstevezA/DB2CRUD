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
it('does not undo what others change in a list', async () => {
  const { id } = await addOrder(uow(), 1)
  const item = newOrder(3).lines[0]
  await Promise.all([uow().orders.addLine(id, item), uow().orders.addLine(id, item), uow().orders.addLine(id, { ...item, status: 'sent' })])
  const found = (await uow().orders.READ_ID(id))!
  expect(found.lines).toHaveLength(4)
  await Promise.all(found.lines.slice(1, 3).map((line) => uow().orders.removeLine(id, line._id!)))
  expect((await uow().orders.READ_ID(id))!.lines.map((line) => line.status)).toEqual(['pending', 'sent'])
  // A document that does not follow the schema is refused by the database layer too
  await expect(uow().orders.addLine(id, { quantity: 1 } as never)).rejects.toMatchObject({ name: 'ValidationFailedError' })
  expect(await uow().orders.addLine('f'.repeat(24), item)).toBeNull()
})

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
    .replace('TRANSACTION', settings.transactions === 'operation' ? TRANSACTION : '')
    .replaceAll("import('../src/database.js')", "import('../src/database.js')")
  return [...files, { ...test, content }]
}

// Java: the same, in JUnit

const JAVA_SHOP = `package app;

import static org.junit.jupiter.api.Assertions.*;

import app.entities.*;
import app.errors.ConflictException;
import java.util.List;
import java.util.stream.IntStream;
import org.bson.Document;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class RoundTripTest {
    private MongoUnitOfWork uow;

    @BeforeEach
    void open() {
        uow = new MongoUnitOfWork(TestDatabase.open());
    }

    private Document stored(String collection) {
        return uow.mongo().getCollection(collection).find().first();
    }

    @Test
    void keepsEveryValueAndItsType() {
        Product product = uow.products().insert(Factories.newProduct(1));
        Product found = uow.products().findById(product.getId()).orElseThrow();
        assertEquals(0, product.getPrice().compareTo(found.getPrice()));
        assertEquals(product.getReference(), found.getReference());
        assertArrayEquals(product.getPicture(), found.getPicture());
        product.setRelated(List.of("0123456789abcdef01234567"));
        uow.products().update(product);
        Document document = stored("products");
        assertEquals("ObjectId Decimal128 Binary ObjectId", document.get("_id").getClass().getSimpleName() + " " + document.get("price").getClass().getSimpleName() + " "
                + document.get("reference", Object.class).getClass().getSimpleName().replace("UUID", "Binary") + " " + document.getList("related", Object.class).get(0).getClass().getSimpleName());
        assertFalse(document.containsKey("_class"));
        Order order = Factories.addOrder(uow, 2);
        Order read = uow.orders().findById(order.getId()).orElseThrow();
        assertEquals(order.getLines().get(0).getId(), read.getLines().get(0).getId());
        assertEquals(order.getNotes().get(0).getAt(), read.getNotes().get(0).getAt());
        Document line = stored("orders").getList("lines", Document.class).get(0);
        assertEquals("ObjectId ObjectId Decimal128", line.get("_id").getClass().getSimpleName() + " " + line.get("product").getClass().getSimpleName() + " " + line.get("price").getClass().getSimpleName());
        Customer customer = Factories.addCustomer(uow, 5);
        Customer other = uow.customers().findById(customer.getId()).orElseThrow();
        assertEquals(customer.getAddress().getZipCode(), other.getAddress().getZipCode());
        assertEquals(customer.getPreferences().getTheme(), other.getPreferences().getTheme());
    }

    @Test
    void changesOnlyWhatIsDifferent() {
        String id = Factories.addCustomer(uow, 1).getId();
        uow.mongo().getCollection("customers").updateOne(new Document(), new Document("$set", new Document("unknown", 1).append("address.unknown", 2)));
        Customer one = uow.customers().findById(id).orElseThrow();
        Customer other = uow.customers().findById(id).orElseThrow();
        one.setName("one");
        other.setLevel("gold");
        other.getAddress().setCity("Madrid");
        other.setPasswordHash(null);
        uow.customers().update(one);
        uow.customers().update(other);
        Document document = stored("customers");
        assertEquals("one gold 1", document.get("name") + " " + document.get("level") + " " + document.get("unknown"));
        assertEquals("Madrid 2", document.get("address", Document.class).get("city") + " " + document.get("address", Document.class).get("unknown"));
        assertFalse(document.containsKey("passwordHash"));
    }

    @Test
    void doesNotUndoWhatOthersChangeInAList() {
        String id = Factories.addOrder(uow, 1).getId();
        IntStream.range(0, 4).parallel().forEach((n) -> uow.orders().addLine(id, Factories.newOrderLine(n)));
        Order found = uow.orders().findById(id).orElseThrow();
        assertEquals(5, found.getLines().size());
        found.getLines().subList(1, 5).parallelStream().forEach((line) -> uow.orders().removeLine(id, line.getId()));
        assertEquals(1, uow.orders().findById(id).orElseThrow().getLines().size());
        assertTrue(uow.orders().addLine("f".repeat(24), Factories.newOrderLine(1)).isEmpty());
        assertTrue(uow.orders().findById("nothing").isEmpty());
        assertTrue(uow.orders().addLine("nothing", Factories.newOrderLine(1)).isEmpty());
    }

    @Test
    void refusesRepeatedValues() {
        Factories.addCustomer(uow, 1);
        assertThrows(ConflictException.class, () -> Factories.addCustomer(uow, 1));
    }
TRANSACTION
    @Test
    void createsNothingInTheDatabase() {
        uow.mongo().getDb().drop();
        var mongo = Database.template(Database.client(TestDatabase.URL), uow.mongo().getDb().getName());
        assertTrue(mongo.findAll(Customer.class).isEmpty());
        assertTrue(mongo.getCollectionNames().isEmpty());
    }
}
`

const JAVA_TRANSACTION = `
    @Test
    void undoesATransactionThatFails() {
        assertThrows(IllegalStateException.class, () -> uow.transaction((inside) -> {
            Customer customer = Factories.addCustomer(inside, 1);
            customer.setName("changed");
            inside.customers().update(customer);
            throw new IllegalStateException("stop");
        }));
        assertNull(stored("customers"));
    }
`

const JAVA_CLINIC = `package app;

import static org.junit.jupiter.api.Assertions.*;

import app.entities.*;
import app.errors.ConflictException;
import java.math.BigDecimal;
import java.util.List;
import org.bson.Document;
import org.junit.jupiter.api.Test;

class RoundTripTest {
    @Test
    void fitsTheValidatorsOfTheCollections() {
        MongoUnitOfWork uow = new MongoUnitOfWork(TestDatabase.open());
        // The collections with the validators of their own script, as JSON
        Document validators = Document.parse(VALIDATORS);
        validators.forEach((name, validator) -> uow.mongo().getDb().runCommand(new Document("collMod", name).append("validator", validator).append("validationAction", "error")));
        Patient patient = uow.patients().insert(Factories.newPatient(1));
        Patient found = uow.patients().findById(patient.getId()).orElseThrow();
        assertEquals(patient.getBirth(), found.getBirth());
        assertEquals(0, patient.getBalance().compareTo(found.getBalance()));
        Room room = Factories.addRoom(uow, 1);
        found.setWeight(70.0);
        found.setBalance(null);
        found.setVisits(3);
        Patient.Contact contact = new Patient.Contact();
        contact.setKind("email");
        contact.setValue("a@b.c");
        found.getContacts().add(contact);
        room.setBeds(4L);
        uow.patients().update(found);
        uow.rooms().update(room);
        Patient changed = uow.patients().findById(patient.getId()).orElseThrow();
        assertEquals("70.0 null 3 2", changed.getWeight() + " " + changed.getBalance() + " " + changed.getVisits() + " " + changed.getContacts().size());
        assertEquals(4L, uow.rooms().findById(room.getId()).orElseThrow().getBeds());
        assertThrows(ConflictException.class, () -> uow.patients().insert(Factories.newPatient(1)));
        Factories.addPatient(uow, 2);
        // What only the validator of the collection knows is refused too
        Patient wrong = Factories.newPatient(3);
        wrong.setBlood("Z");
        assertThrows(ConflictException.class, () -> uow.patients().insert(wrong));
        assertThrows(ConflictException.class, () -> {
            Patient.Contact odd = new Patient.Contact();
            odd.setKind("fax");
            uow.patients().addContact(patient.getId(), odd);
        });
        assertEquals(List.of(), List.of());
        assertNotNull(new BigDecimal("1"));
    }
}
`

/** The validators of verification/mongodb/clinic.js, by collection, as the script gives them. */
function clinicValidators() {
  const result = {}
  const collection = { createIndex: () => {} }
  const db = { createCollection: (name, options) => (result[name] = options.validator), getCollection: () => collection, patients: collection }
  new Function('db', readFileSync(new URL('./mongodb/clinic.js', import.meta.url), 'utf8'))(db)
  return result
}

export function withJavaRoundTrip(files, settings, code) {
  if (settings.architecture === 'table' || settings.verbs === 'get') return files
  const shop = code.endsWith('shop.ts')
  const content = shop
    ? JAVA_SHOP.replace('TRANSACTION', settings.transactions === 'operation' ? JAVA_TRANSACTION : '')
    : JAVA_CLINIC.replace('VALIDATORS', JSON.stringify(JSON.stringify(clinicValidators())))
  return [...files, { path: 'src/test/java/app/RoundTripTest.java', content }]
}
