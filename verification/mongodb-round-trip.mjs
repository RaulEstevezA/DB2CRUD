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
it('keeps the unknown fields of items', async () => {
  const { id } = await addOrder(uow(), 1)
  const orders = uow().db.connection.collection('orders')
  await orders.updateOne({}, { $set: { 'lines.0.unknown': 5 } })
  const found = (await uow().orders.READ_ID(id))!
  found.lines.push(newOrder(2).lines[0])
  await uow().orders.update(found)
  const lines = (await orders.findOne({}))!.lines as Record<string, unknown>[]
  expect(lines.map((line) => line.unknown)).toEqual([5, undefined])
})

it('does not undo what others change in a list', async () => {
  const { id } = await addOrder(uow(), 1)
  const item = newOrder(3).lines[0]
  await Promise.all([uow().orders.addLine(id, item), uow().orders.addLine(id, item), uow().orders.addLine(id, { ...item, status: 'sent' })])
  const found = (await uow().orders.READ_ID(id))!
  expect(found.lines).toHaveLength(4)
  // The three were added at the same time, so in any order
  await Promise.all(found.lines.slice(1).filter((line) => line.status === 'pending').map((line) => uow().orders.removeLine(id, line._id!)))
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
    void keepsTheUnknownFieldsOfItems() {
        String id = Factories.addOrder(uow, 1).getId();
        uow.mongo().getCollection("orders").updateOne(new Document(), new Document("$set", new Document("lines.0.unknown", 5).append("lines.0.more", List.of(new Document("a", 1)))));
        Order found = uow.orders().findById(id).orElseThrow();
        List<Order.Line> lines = new java.util.ArrayList<>(found.getLines());
        lines.get(0).setQuantity(7.0);
        lines.add(0, Factories.newOrderLine(2));
        found.setLines(lines);
        uow.orders().update(found);
        List<Document> kept = stored("orders").getList("lines", Document.class);
        assertEquals(2, kept.size());
        assertNull(kept.get(0).get("unknown"));
        assertEquals("7 5 1", kept.get(1).get("quantity", Number.class).intValue() + " " + kept.get(1).get("unknown") + " " + kept.get(1).getList("more", Document.class).get(0).get("a"));
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

// Python: the same, in pytest

const PYTHON_SHOP = `import asyncio
from datetime import UTC, datetime
from typing import Any

import pytest
from bson import Decimal128, ObjectId

from app.db import open_database
from app.errors import ConflictError, ValidationFailedError
from app.unit_of_work import MongoUnitOfWork
from tests.factories import add_customer, add_order, add_product, new_customer, new_order, new_product


def collection(uow: MongoUnitOfWork, name: str) -> Any:
    return uow.db.client.get_default_database()[name]


async def test_keeps_every_value_and_its_type(mongo_uow: MongoUnitOfWork) -> None:
    product = new_product(1)
    product.related = ["0123456789abcdef01234567"]
    await mongo_uow.products.insert(product)
    found = await mongo_uow.products.READ_ID(product.id)
    assert vars(found) == vars(product)
    document = await collection(mongo_uow, "products").find_one()
    assert [type(document[name]).__name__ for name in ("_id", "price", "reference")] == ["ObjectId", "Decimal128", "UUID"]
    assert document["related"] == [ObjectId("0123456789abcdef01234567")] and document["picture"] == product.picture
    customer = new_customer(1)
    customer.extra = {"a": None, "b": ObjectId(), "c": [1, {"d": 2.5}]}
    customer.created_at = datetime(2026, 1, 1, 1, 1, 1, 123456, tzinfo=UTC)
    await mongo_uow.customers.insert(customer)
    read = await mongo_uow.customers.READ_ID(customer.id)
    assert read is not None and read.extra == customer.extra and read.address == customer.address
    assert (await collection(mongo_uow, "customers").find_one())["address"]["zip code"] == customer.address["zip code"]
    order = await add_order(mongo_uow, 2)
    assert vars(await mongo_uow.orders.READ_ID(order.id))["lines"] == order.lines
    line = (await collection(mongo_uow, "orders").find_one())["lines"][0]
    assert [type(line[name]) for name in ("_id", "product", "price")] == [ObjectId, ObjectId, Decimal128]


async def test_changes_only_what_is_different(mongo_uow: MongoUnitOfWork) -> None:
    stored = await add_customer(mongo_uow, 1)
    customers = collection(mongo_uow, "customers")
    await customers.update_one({}, {"$set": {"unknown": 1, "address.unknown": 2}})
    one = await mongo_uow.customers.READ_ID(stored.id)
    other = await mongo_uow.customers.READ_ID(stored.id)
    one.name = "one"
    other.level = "gold"
    other.address["city"] = "Madrid"
    other.password_hash = None
    await mongo_uow.customers.update(one)
    await mongo_uow.customers.update(other)
    document = await customers.find_one()
    assert [document[name] for name in ("name", "level", "unknown")] == ["one", "gold", 1]
    assert document["address"]["city"] == "Madrid" and document["address"]["unknown"] == 2
    assert "passwordHash" not in document and document["updatedAt"] > document["createdAt"]
    # The entity an insert gives changes only its fields too
    stored.name = "again"
    await mongo_uow.customers.update(stored)
    assert (await customers.find_one())["level"] == "gold"


async def test_keeps_the_unknown_fields_of_items(mongo_uow: MongoUnitOfWork) -> None:
    order = await add_order(mongo_uow, 1)
    await collection(mongo_uow, "orders").update_one({}, {"$set": {"lines.0.unknown": 5}})
    found = await mongo_uow.orders.READ_ID(order.id)
    found.lines.append(new_order(2).lines[0])
    await mongo_uow.orders.update(found)
    lines = (await collection(mongo_uow, "orders").find_one())["lines"]
    assert [line.get("unknown") for line in lines] == [5, None] and all("_id" in line for line in lines)


async def test_does_not_undo_what_others_change_in_a_list(mongo_uow: MongoUnitOfWork) -> None:
    order = await add_order(mongo_uow, 1)
    await asyncio.gather(*(mongo_uow.orders.add_line(order.id, new_order(n).lines[0]) for n in range(1, 5)))
    found = await mongo_uow.orders.READ_ID(order.id)
    assert len(found.lines) == 5
    await asyncio.gather(*(mongo_uow.orders.remove_line(order.id, line["_id"]) for line in found.lines[1:]))
    assert len((await mongo_uow.orders.READ_ID(order.id)).lines) == 1
    assert await mongo_uow.orders.add_line("f" * 24, new_order(1).lines[0]) is None
    assert await mongo_uow.orders.add_line("nothing", new_order(1).lines[0]) is None
    assert await mongo_uow.orders.READ_ID("nothing") is None


async def test_refuses_repeated_and_wrong_values(mongo_uow: MongoUnitOfWork) -> None:
    await add_customer(mongo_uow, 1)
    with pytest.raises(ConflictError):
        await mongo_uow.customers.insert(new_customer(1))
    wrong = new_customer(2)
    wrong.address = {"street": []}  # type: ignore[typeddict-item]
    with pytest.raises(ValidationFailedError):
        await mongo_uow.customers.insert(wrong)
    product = await add_product(mongo_uow, 1)
    product.related = ["nothing"]
    with pytest.raises(ValidationFailedError):
        await mongo_uow.products.update(product)

TRANSACTION
async def test_creates_nothing_in_the_database(mongo_uow: MongoUnitOfWork) -> None:
    database = mongo_uow.db.client.get_default_database()
    await mongo_uow.db.client.drop_database(database.name)
    import os

    client = await open_database(os.environ["TEST_DATABASE_URL"])
    assert await MongoUnitOfWork(client).customers.READ_ID("f" * 24) is None
    assert await database.list_collection_names() == []
    await client.close()
`

const PYTHON_TRANSACTION = `
async def test_undoes_a_transaction_that_fails(mongo_uow: MongoUnitOfWork) -> None:
    await add_product(mongo_uow, 1)
    with pytest.raises(RuntimeError):
        async with mongo_uow.transaction():
            customer = await add_customer(mongo_uow, 1)
            customer.name = "changed"
            await mongo_uow.customers.update(customer)
            async with mongo_uow.transaction():
                assert await mongo_uow.customers.READ_ID(customer.id) is not None
            raise RuntimeError("stop")
    assert await collection(mongo_uow, "customers").count_documents({}) == 0
    async with mongo_uow.transaction():
        await add_customer(mongo_uow, 1)
    assert await collection(mongo_uow, "customers").count_documents({}) == 1

`

const PYTHON_CLINIC = `import json

import pytest

from app.errors import ConflictError
from app.unit_of_work import MongoUnitOfWork
from tests.factories import add_patient, add_room, new_patient

VALIDATORS = json.loads(VALIDATORS_JSON)


async def test_fits_the_validators_of_the_collections(mongo_uow: MongoUnitOfWork) -> None:
    database = mongo_uow.db.client.get_default_database()
    for name, validator in VALIDATORS.items():
        if name not in await database.list_collection_names():
            await database.create_collection(name)
        await database.command({"collMod": name, "validator": validator, "validationAction": "error"})
    patient = await mongo_uow.patients.insert(new_patient(1))
    found = await mongo_uow.patients.find_by_id(patient.id)
    assert vars(found) == vars(patient)
    room = await add_room(mongo_uow, 1)
    found.weight = 70
    found.balance = None
    found.visits = 3
    found.contacts.append({"kind": "email", "value": "a@b.c"})
    room.beds = 4
    await mongo_uow.patients.update(found)
    await mongo_uow.rooms.update(room)
    changed = await mongo_uow.patients.find_by_id(patient.id)
    assert (changed.weight, changed.balance, changed.visits, changed.contacts) == (70, None, 3, found.contacts)
    assert (await mongo_uow.rooms.find_by_id(room.id)).beds == 4
    with pytest.raises(ConflictError):
        await mongo_uow.patients.insert(new_patient(1))
    await add_patient(mongo_uow, 2)
    # What only the validator of the collection knows is refused too
    with pytest.raises(ConflictError):
        await mongo_uow.patients.insert(new_patient(3, blood="Z"))
    with pytest.raises(ConflictError):
        await mongo_uow.patients.add_contact(patient.id, {"kind": "fax", "value": "1"})
`

export function withPythonRoundTrip(files, settings, code) {
  const content = code.endsWith('shop.ts')
    ? PYTHON_SHOP.replace('TRANSACTION', settings.transactions === 'operation' ? PYTHON_TRANSACTION : '').replaceAll(
        'READ_ID',
        settings.verbs === 'get' ? 'get_by_id' : 'find_by_id',
      )
    : PYTHON_CLINIC.replace('VALIDATORS_JSON', JSON.stringify(JSON.stringify(clinicValidators())))
  return [...files, { path: 'tests/test_round_trip.py', content }]
}

// C#: the same, in xUnit

const CSHARP_SHOP = `using App;
using App.Entities;
using App.Errors;
using MongoDB.Bson;
using MongoDB.Driver;
using Xunit;

namespace App.Tests;

public class RoundTripTests : IAsyncLifetime
{
    private Db db = null!;
    private MongoUnitOfWork uow = null!;

    public async ValueTask InitializeAsync()
    {
        db = await TestDatabase.OpenAsync();
        uow = new MongoUnitOfWork(db);
    }

    public async ValueTask DisposeAsync() => await db.DisposeAsync();

    private async Task<BsonDocument?> Stored(string collection) =>
        await db.Database.GetCollection<BsonDocument>(collection).Find(new BsonDocument()).FirstOrDefaultAsync();

    [Fact]
    public async Task KeepsEveryValueAndItsType()
    {
        var product = await uow.Products.InsertAsync(Factories.NewProduct(1));
        var found = (await uow.Products.READ_ID(product.Id))!;
        Assert.Equal(product.Price, found.Price);
        Assert.Equal(product.Reference, found.Reference);
        Assert.Equal(product.Picture, found.Picture);
        product.Related = ["0123456789abcdef01234567"];
        await uow.Products.UpdateAsync(product);
        Assert.Equal(product.Related, (await uow.Products.READ_ID(product.Id))!.Related);
        var document = (await Stored("products"))!;
        Assert.Equal("ObjectId Decimal128 Binary ObjectId", $"{document["_id"].BsonType} {document["price"].BsonType} {document["reference"].BsonType} {document["related"][0].BsonType}");
        Assert.Equal(BsonBinarySubType.UuidStandard, document["reference"].AsBsonBinaryData.SubType);
        Assert.False(document.Contains("_t"));
        var order = await Factories.AddOrderAsync(uow, 2);
        var read = (await uow.Orders.READ_ID(order.Id))!;
        Assert.Equal(order.Lines[0].Id, read.Lines[0].Id);
        Assert.Equal(order.Notes![0].At, read.Notes![0].At);
        Assert.Equal(DateTimeKind.Utc, read.Notes[0].At!.Value.Kind);
        var line = (await Stored("orders"))!["lines"][0];
        Assert.Equal("ObjectId ObjectId Decimal128", $"{line["_id"].BsonType} {line["product"].BsonType} {line["price"].BsonType}");
        var customer = await Factories.AddCustomerAsync(uow, 5);
        var other = (await uow.Customers.READ_ID(customer.Id))!;
        Assert.Equivalent(customer.Address, other.Address);
        Assert.Equivalent(customer.Preferences, other.Preferences);
        Assert.Equal(customer.Extra, other.Extra);
    }

    [Fact]
    public async Task ChangesOnlyWhatIsDifferent()
    {
        var id = (await Factories.AddCustomerAsync(uow, 1)).Id;
        await db.Database.GetCollection<BsonDocument>("customers").UpdateOneAsync(new BsonDocument(), new BsonDocument("$set", new BsonDocument { ["unknown"] = 1, ["address.unknown"] = 2 }));
        var one = (await uow.Customers.READ_ID(id))!;
        var other = (await uow.Customers.READ_ID(id))!;
        one.Name = "one";
        other.Level = "gold";
        other.Address!.City = "Madrid";
        other.PasswordHash = null;
        await uow.Customers.UpdateAsync(one);
        await uow.Customers.UpdateAsync(other);
        var document = (await Stored("customers"))!;
        Assert.Equal("one gold 1", $"{document["name"]} {document["level"]} {document["unknown"]}");
        Assert.Equal("Madrid 2", $"{document["address"]["city"]} {document["address"]["unknown"]}");
        Assert.False(document.Contains("passwordHash"));
    }

    [Fact]
    public async Task KeepsTheUnknownFieldsOfItems()
    {
        var id = (await Factories.AddOrderAsync(uow, 1)).Id;
        await db.Database.GetCollection<BsonDocument>("orders").UpdateOneAsync(new BsonDocument(), new BsonDocument("$set", new BsonDocument { ["lines.0.unknown"] = 5, ["lines.0.more"] = new BsonArray { new BsonDocument("a", 1) } }));
        var found = (await uow.Orders.READ_ID(id))!;
        found.Lines[0].Quantity = 7;
        found.Lines.Insert(0, Factories.NewOrderLine(2));
        await uow.Orders.UpdateAsync(found);
        var kept = (await Stored("orders"))!["lines"].AsBsonArray;
        Assert.Equal(2, kept.Count);
        Assert.False(kept[0].AsBsonDocument.Contains("unknown"));
        Assert.Equal("7 5 1", $"{kept[1]["quantity"]} {kept[1]["unknown"]} {kept[1]["more"][0]["a"]}");
        Assert.DoesNotContain("unknown", System.Text.Json.JsonSerializer.Serialize(found.Lines));
    }

    [Fact]
    public async Task DoesNotUndoWhatOthersChangeInAList()
    {
        var id = (await Factories.AddOrderAsync(uow, 1)).Id;
        await Task.WhenAll(Enumerable.Range(0, 4).Select(n => uow.Orders.AddLineAsync(id, Factories.NewOrderLine(n))));
        var found = (await uow.Orders.READ_ID(id))!;
        Assert.Equal(5, found.Lines.Count);
        await Task.WhenAll(found.Lines.Skip(1).Select(line => uow.Orders.RemoveLineAsync(id, line.Id!)));
        Assert.Single((await uow.Orders.READ_ID(id))!.Lines);
        Assert.Null(await uow.Orders.AddLineAsync(new string('f', 24), Factories.NewOrderLine(1)));
        Assert.Null(await uow.Orders.READ_ID("nothing"));
        Assert.Null(await uow.Orders.AddLineAsync("nothing", Factories.NewOrderLine(1)));
        Assert.Null(await uow.Orders.RemoveLineAsync(id, "nothing"));
    }

    [Fact]
    public async Task RefusesRepeatedValues()
    {
        await Factories.AddCustomerAsync(uow, 1);
        await Assert.ThrowsAsync<ConflictException>(() => Factories.AddCustomerAsync(uow, 1));
    }
TRANSACTION
    [Fact]
    public async Task CreatesNothingInTheDatabase()
    {
        await db.Database.Client.DropDatabaseAsync(db.Database.DatabaseNamespace.DatabaseName);
        var other = new MongoUnitOfWork(new Db(Database.At(TestDatabase.Connection!)));
        Assert.Null(await other.Customers.READ_ID(new string('f', 24)));
        Assert.Empty(await (await db.Database.ListCollectionNamesAsync()).ToListAsync());
    }
}
`

const CSHARP_TRANSACTION = `
    [Fact]
    public async Task UndoesATransactionThatFails()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() => uow.TransactionAsync(async inside =>
        {
            var customer = await Factories.AddCustomerAsync(inside, 1);
            customer.Name = "changed";
            await inside.Customers.UpdateAsync(customer);
            throw new InvalidOperationException("stop");
        }));
        Assert.Null(await Stored("customers"));
        await uow.TransactionAsync(async inside => { await Factories.AddCustomerAsync(inside, 1); });
        Assert.NotNull(await Stored("customers"));
    }
`

const CSHARP_CLINIC = `using App;
using App.Entities;
using App.Errors;
using MongoDB.Bson;
using Xunit;

namespace App.Tests;

public class RoundTripTests
{
    [Fact]
    public async Task FitsTheValidatorsOfTheCollections()
    {
        await using var db = await TestDatabase.OpenAsync();
        var uow = new MongoUnitOfWork(db);
        // The collections with the validators of their own script, as JSON
        foreach (var validator in BsonDocument.Parse(VALIDATORS))
            await db.Database.RunCommandAsync<BsonDocument>(new BsonDocument { ["collMod"] = validator.Name, ["validator"] = validator.Value, ["validationAction"] = "error" });
        var patient = await uow.Patients.InsertAsync(Factories.NewPatient(1));
        var found = (await uow.Patients.FindByIdAsync(patient.Id))!;
        Assert.Equal(patient.Birth, found.Birth);
        Assert.Equal(patient.Balance, found.Balance);
        var room = await Factories.AddRoomAsync(uow, 1);
        found.Weight = 70;
        found.Balance = null;
        found.Visits = 3;
        found.Contacts.Add(new Patient.ContactDocument { Kind = "email", Value = "a@b.c" });
        room.Beds = 4;
        await uow.Patients.UpdateAsync(found);
        await uow.Rooms.UpdateAsync(room);
        var changed = (await uow.Patients.FindByIdAsync(patient.Id))!;
        Assert.Equal((70.0, null, 3, 2), (changed.Weight, changed.Balance, changed.Visits, changed.Contacts.Count));
        Assert.Equal(4L, (await uow.Rooms.FindByIdAsync(room.Id))!.Beds);
        await Assert.ThrowsAsync<ConflictException>(() => uow.Patients.InsertAsync(Factories.NewPatient(1)));
        await Factories.AddPatientAsync(uow, 2);
        // What only the validator of the collection knows is refused too
        var wrong = Factories.NewPatient(3);
        wrong.Blood = "Z";
        await Assert.ThrowsAsync<ConflictException>(() => uow.Patients.InsertAsync(wrong));
        await Assert.ThrowsAsync<ConflictException>(() => uow.Patients.AddContactAsync(patient.Id, new Patient.ContactDocument { Kind = "fax", Value = "" }));
    }
}
`

export function withCsharpRoundTrip(files, settings, code) {
  if (settings.architecture === 'table') return files
  const shop = code.endsWith('shop.ts')
  const read = settings.verbs === 'get' ? 'GetByIdAsync' : 'FindByIdAsync'
  const content = shop
    ? CSHARP_SHOP.replace('TRANSACTION', settings.transactions === 'operation' ? CSHARP_TRANSACTION : '')
    : CSHARP_CLINIC.replace('VALIDATORS', JSON.stringify(JSON.stringify(clinicValidators())))
  return [...files, { path: 'tests/App.Tests/RoundTripTests.cs', content: content.replaceAll('READ_ID', read).replaceAll('FindByIdAsync', read) }]
}

// PHP: the same, in PHPUnit

const PHP_SHOP = `<?php

declare(strict_types=1);

namespace Tests;

use App\\Database;
use App\\Errors\\ConflictException;
use App\\Errors\\ValidationFailedException;
use App\\MongoUnitOfWork;
use MongoDB\\BSON\\Binary;
use MongoDB\\BSON\\Decimal128;
use MongoDB\\BSON\\ObjectId;
use PHPUnit\\Framework\\TestCase;

final class RoundTripTest extends TestCase
{
    private MongoUnitOfWork $uow;

    protected function setUp(): void
    {
        $this->uow = TestDatabase::open();
    }

    private function stored(string $collection): ?array
    {
        return $this->uow->db->collection($collection)->findOne();
    }

    public function testKeepsEveryValueAndItsType(): void
    {
        $product = Factories::newProduct(1);
        $product->related = ['0123456789abcdef01234567'];
        $product->picture = "\\x00\\xff bytes";
        $this->uow->products->insert($product);
        $found = $this->uow->products->READ_ID($product->id);
        self::assertEquals(get_object_vars($product), get_object_vars($found));
        self::assertSame($product->price, $found->price);
        $document = $this->stored('products');
        self::assertInstanceOf(ObjectId::class, $document['_id']);
        self::assertInstanceOf(Decimal128::class, $document['price']);
        self::assertSame(Binary::TYPE_UUID, $document['reference']->getType());
        self::assertInstanceOf(ObjectId::class, $document['related'][0]);
        self::assertIsFloat($document['stock']);
        $customer = Factories::newCustomer(1);
        $customer->extra = ['a' => null, 'b' => new ObjectId(), 'c' => [1, ['d' => 2.5]]];
        $this->uow->customers->insert($customer);
        $read = $this->uow->customers->READ_ID($customer->id);
        self::assertEquals($customer->extra, $read->extra);
        self::assertEquals($customer->address, $read->address);
        $order = Factories::addOrder($this->uow, 2);
        $again = $this->uow->orders->READ_ID($order->id);
        self::assertEquals($order->lines, $again->lines);
        self::assertEquals($order->notes, $again->notes);
        $line = $this->uow->db->collection('orders')->findOne()['lines'][0];
        self::assertInstanceOf(ObjectId::class, $line['_id']);
        self::assertInstanceOf(ObjectId::class, $line['product']);
        self::assertInstanceOf(Decimal128::class, $line['price']);
    }

    public function testChangesOnlyWhatIsDifferent(): void
    {
        $stored = Factories::addCustomer($this->uow, 1);
        $this->uow->db->collection('customers')->updateOne([], ['$set' => ['unknown' => 1, 'address.unknown' => 2]]);
        $one = $this->uow->customers->READ_ID($stored->id);
        $other = $this->uow->customers->READ_ID($stored->id);
        $one->name = 'one';
        $other->level = 'gold';
        $other->address['city'] = 'Madrid';
        $other->passwordHash = null;
        $this->uow->customers->update($one);
        $this->uow->customers->update($other);
        $document = $this->stored('customers');
        self::assertSame(['one', 'gold', 1], [$document['name'], $document['level'], $document['unknown']]);
        self::assertSame(['Madrid', 2], [$document['address']['city'], $document['address']['unknown']]);
        self::assertArrayNotHasKey('passwordHash', $document);
        // The entity an insert gives changes only its fields too
        $stored->name = 'again';
        $this->uow->customers->update($stored);
        self::assertSame('gold', $this->stored('customers')['level']);
    }

    public function testKeepsTheUnknownFieldsOfItems(): void
    {
        $order = Factories::addOrder($this->uow, 1);
        $this->uow->db->collection('orders')->updateOne([], ['$set' => ['lines.0.unknown' => 5]]);
        $found = $this->uow->orders->READ_ID($order->id);
        $found->lines[] = Factories::newOrder(2)->lines[0];
        $this->uow->orders->update($found);
        $lines = $this->stored('orders')['lines'];
        self::assertSame([5, null], array_map(fn (array $line) => $line['unknown'] ?? null, $lines));
        self::assertInstanceOf(ObjectId::class, $lines[1]['_id']);
    }

    public function testDoesNotUndoWhatOthersChangeInAList(): void
    {
        $id = Factories::addOrder($this->uow, 1)->id;
        $mine = $this->uow->orders->READ_ID($id);
        foreach ([1, 2, 3] as $n) {
            $this->uow->orders->addLine($id, Factories::newOrder($n)->lines[0]);
        }
        $mine->number = 99.0;
        $this->uow->orders->update($mine);
        $found = $this->uow->orders->READ_ID($id);
        self::assertCount(4, $found->lines);
        foreach (array_slice($found->lines, 1) as $line) {
            $this->uow->orders->removeLine($id, $line['_id']);
        }
        self::assertCount(1, $this->uow->orders->READ_ID($id)->lines);
        self::assertNull($this->uow->orders->addLine(str_repeat('f', 24), Factories::newOrder(1)->lines[0]));
        self::assertNull($this->uow->orders->READ_ID('nothing'));
        self::assertNull($this->uow->orders->addLine('nothing', Factories::newOrder(1)->lines[0]));
        self::assertNull($this->uow->orders->removeLine($id, 'nothing'));
    }

    public function testRefusesRepeatedAndWrongValues(): void
    {
        Factories::addCustomer($this->uow, 1);
        try {
            Factories::addCustomer($this->uow, 1);
            self::fail('A repeated value was taken');
        } catch (ConflictException) {
        }
        $product = Factories::addProduct($this->uow, 1);
        $product->related = ['nothing'];
        $this->expectException(ValidationFailedException::class);
        $this->uow->products->update($product);
    }
TRANSACTION
    public function testCreatesNothingInTheDatabase(): void
    {
        $this->uow->db->database->drop();
        $other = new MongoUnitOfWork(Database::open(TestDatabase::url()));
        self::assertNull($other->customers->READ_ID(str_repeat('f', 24)));
        self::assertSame([], iterator_to_array($this->uow->db->database->listCollectionNames()));
    }
}
`

const PHP_TRANSACTION = `
    public function testUndoesATransactionThatFails(): void
    {
        try {
            $this->uow->transaction(function (\\App\\UnitOfWork $inside): void {
                $customer = Factories::addCustomer($inside, 1);
                $customer->name = 'changed';
                $inside->customers->update($customer);
                throw new \\LogicException('stop');
            });
        } catch (\\LogicException) {
        }
        self::assertNull($this->stored('customers'));
        $this->uow->transaction(fn (\\App\\UnitOfWork $inside) => Factories::addCustomer($inside, 1));
        self::assertNotNull($this->stored('customers'));
    }
`

const PHP_CLINIC = `<?php

declare(strict_types=1);

namespace Tests;

use App\\Errors\\ConflictException;
use PHPUnit\\Framework\\TestCase;

final class RoundTripTest extends TestCase
{
    public function testFitsTheValidatorsOfTheCollections(): void
    {
        $uow = TestDatabase::open();
        // The collections with the validators of their own script, as JSON
        foreach (json_decode(VALIDATORS, true) as $name => $validator) {
            $uow->db->database->command(['collMod' => $name, 'validator' => $validator, 'validationAction' => 'error']);
        }
        $patient = $uow->patients->insert(Factories::newPatient(1));
        $found = $uow->patients->findById($patient->id);
        self::assertEquals(get_object_vars($patient), get_object_vars($found));
        $room = Factories::addRoom($uow, 1);
        $found->weight = 70.0;
        $found->balance = null;
        $found->visits = 3;
        $found->contacts[] = ['kind' => 'email', 'value' => 'a@b.c'];
        $room->beds = 4;
        $uow->patients->update($found);
        $uow->rooms->update($room);
        $changed = $uow->patients->findById($patient->id);
        self::assertSame([70.0, null, 3, 2], [$changed->weight, $changed->balance, $changed->visits, count($changed->contacts)]);
        self::assertSame(4, $uow->rooms->findById($room->id)->beds);
        Factories::addPatient($uow, 2);
        // What only the validator of the collection knows is refused too
        $wrong = Factories::newPatient(3);
        $wrong->blood = 'Z';
        $refused = [
            fn () => $uow->patients->insert(Factories::newPatient(1)),
            fn () => $uow->patients->insert($wrong),
            fn () => $uow->patients->addContact($patient->id, ['kind' => 'fax', 'value' => '']),
        ];
        foreach ($refused as $index => $write) {
            try {
                $write();
                self::fail("The write {$index} was taken");
            } catch (ConflictException) {
            }
        }
    }
}
`

export function withPhpRoundTrip(files, settings, code) {
  if (settings.architecture === 'table') return files
  const shop = code.endsWith('shop.ts')
  const read = settings.verbs === 'get' ? 'getById' : 'findById'
  const content = shop
    ? PHP_SHOP.replace('TRANSACTION', settings.transactions === 'operation' ? PHP_TRANSACTION : '')
    : PHP_CLINIC.replace('VALIDATORS', () => `'${JSON.stringify(clinicValidators()).replace(/'/g, "\\'")}'`)
  return [...files, { path: 'tests/RoundTripTest.php', content: content.replaceAll('READ_ID', read) }]
}

// Kotlin: the same, in kotlin.test

const KOTLIN_SHOP = `package app

import app.entities.Order
import app.errors.ConflictException
import java.util.UUID
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.bson.Document
import org.bson.types.Binary
import org.bson.types.Decimal128
import org.bson.types.ObjectId

class RoundTripTest {
    private lateinit var uow: MongoUnitOfWork

    @BeforeTest
    fun open() {
        uow = TestDatabase.open()
    }

    @AfterTest
    fun close() {
        uow.db.close()
    }

    private fun stored(collection: String): Document? = uow.db.database.getCollection<Document>(collection).find().toList().firstOrNull()

    @Test
    fun keepsEveryValueAndItsType() {
        val product = uow.products.insert(Factories.newProduct(1))
        val found = uow.products.READ_ID(product.id!!)!!
        assertEquals(product.price, found.price)
        assertEquals(product.reference, found.reference)
        assertContentEquals(product.picture, found.picture)
        product.related = listOf("0123456789abcdef01234567")
        uow.products.update(product)
        assertEquals(product.related, uow.products.READ_ID(product.id!!)!!.related)
        val document = stored("products")!!
        assertIs<ObjectId>(document["_id"])
        assertIs<Decimal128>(document["price"])
        assertIs<UUID>(document["reference"])
        assertIs<Binary>(document["picture"])
        assertIs<ObjectId>((document["related"] as List<*>)[0])
        val order = Factories.addOrder(uow, 2)
        val read = uow.orders.READ_ID(order.id!!)!!
        assertEquals(order.lines, read.lines)
        assertEquals(order.notes, read.notes)
        val line = (stored("orders")!!["lines"] as List<*>)[0] as Document
        assertIs<ObjectId>(line["_id"])
        assertIs<ObjectId>(line["product"])
        assertIs<Decimal128>(line["price"])
        val customer = Factories.addCustomer(uow, 5)
        val other = uow.customers.READ_ID(customer.id!!)!!
        assertEquals(customer.address, other.address)
        assertEquals(customer.preferences, other.preferences)
        assertEquals<Any?>(Document(customer.extra as Map<String, Any?>), other.extra)
    }

    @Test
    fun changesOnlyWhatIsDifferent() {
        val inserted = Factories.addCustomer(uow, 1)
        val id = inserted.id!!
        uow.db.database.getCollection<Document>("customers")
            .updateOne(Document(), Document("\\$set", Document("unknown", 1).append("address.unknown", 2)))
        val one = uow.customers.READ_ID(id)!!
        val other = uow.customers.READ_ID(id)!!
        one.name = "one"
        (one.extra as Document)["n"] = 42
        other.level = "gold"
        other.address!!.city = "Madrid"
        other.passwordHash = null
        uow.customers.update(one)
        uow.customers.update(other)
        val document = stored("customers")!!
        assertEquals(listOf<Any?>("one", "gold", 1), listOf(document["name"], document["level"], document["unknown"]))
        val address = document["address"] as Document
        assertEquals(listOf<Any?>("Madrid", 2), listOf(address["city"], address["unknown"]))
        assertEquals<Any?>(42, (document["extra"] as Document)["n"])
        assertEquals(false, "passwordHash" in document)
        // The entity an insert gives changes only its fields too
        inserted.name = "again"
        uow.customers.update(inserted)
        assertEquals<Any?>("gold", stored("customers")!!["level"])
    }

    @Test
    fun doesNotUndoWhatOthersChangeInAList() {
        val id = Factories.addOrder(uow, 1).id!!
        val mine = uow.orders.READ_ID(id)!!
        (0..3).map { thread { uow.orders.addLine(id, Factories.newOrderLine(it)) } }.forEach { it.join() }
        mine.number = 99.0
        uow.orders.update(mine)
        val found = uow.orders.READ_ID(id)!!
        assertEquals(5, found.lines!!.size)
        found.lines!!.drop(1).map { thread { uow.orders.removeLine(id, it.id!!) } }.forEach { it.join() }
        assertEquals(1, uow.orders.READ_ID(id)!!.lines!!.size)
        assertNull(uow.orders.addLine("f".repeat(24), Factories.newOrderLine(1)))
        assertNull(uow.orders.READ_ID("nothing"))
        assertNull(uow.orders.addLine("nothing", Order.Line()))
        assertNull(uow.orders.removeLine(id, "nothing"))
    }

    @Test
    fun refusesRepeatedValues() {
        Factories.addCustomer(uow, 1)
        assertFailsWith<ConflictException> { Factories.addCustomer(uow, 1) }
    }
TRANSACTION
    @Test
    fun createsNothingInTheDatabase() {
        uow.db.database.drop()
        val other = MongoUnitOfWork(Db(TestDatabase.client, AppDatabase.name(TestDatabase.url)))
        assertNull(other.customers.READ_ID("f".repeat(24)))
        assertEquals(emptyList(), uow.db.database.listCollectionNames().toList())
    }
}
`

const KOTLIN_TRANSACTION = `
    @Test
    fun undoesATransactionThatFails() {
        assertFailsWith<IllegalStateException> {
            uow.transaction { inside ->
                val customer = Factories.addCustomer(inside, 1)
                customer.name = "changed"
                inside.customers.update(customer)
                error("stop")
            }
        }
        assertNull(stored("customers"))
        uow.transaction { inside -> Factories.addCustomer(inside, 1) }
        assertNotNull(stored("customers"))
    }
`

const KOTLIN_CLINIC = `package app

import app.entities.Patient
import app.errors.ConflictException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.bson.Document

class RoundTripTest {
    @Test
    fun fitsTheValidatorsOfTheCollections() {
        val uow = TestDatabase.open()
        // The collections with the validators of their own script, as JSON
        for ((name, validator) in Document.parse(VALIDATORS))
            uow.db.database.runCommand(Document("collMod", name).append("validator", validator).append("validationAction", "error"))
        val patient = uow.patients.insert(Factories.newPatient(1))
        val found = uow.patients.findById(patient.id!!)!!
        assertEquals(patient.birth, found.birth)
        assertEquals(patient.balance, found.balance)
        val room = Factories.addRoom(uow, 1)
        found.weight = 70.0
        found.balance = null
        found.visits = 3
        found.contacts = found.contacts!! + Patient.Contact(kind = "email", value = "a@b.c")
        room.beds = 4
        uow.patients.update(found)
        uow.rooms.update(room)
        val changed = uow.patients.findById(patient.id!!)!!
        assertEquals(listOf<Any?>(70.0, null, 3, 2), listOf(changed.weight, changed.balance, changed.visits, changed.contacts!!.size))
        assertEquals(4, uow.rooms.findById(room.id!!)!!.beds)
        assertFailsWith<ConflictException> { uow.patients.insert(Factories.newPatient(1)) }
        Factories.addPatient(uow, 2)
        // What only the validator of the collection knows is refused too
        val wrong = Factories.newPatient(3)
        wrong.blood = "Z"
        assertFailsWith<ConflictException> { uow.patients.insert(wrong) }
        assertFailsWith<ConflictException> { uow.patients.addContact(patient.id!!, Patient.Contact(kind = "fax", value = "")) }
    }
}
`

export function withKotlinRoundTrip(files, settings, code) {
  if (settings.architecture === 'table') return files
  const shop = code.endsWith('shop.ts')
  const read = settings.verbs === 'get' ? 'getById' : 'findById'
  const content = shop
    ? KOTLIN_SHOP.replace('TRANSACTION', () => (settings.transactions === 'operation' ? KOTLIN_TRANSACTION : ''))
    : KOTLIN_CLINIC.replace('VALIDATORS', () => JSON.stringify(JSON.stringify(clinicValidators())).replaceAll('$', '\\$'))
  return [...files, { path: 'src/test/kotlin/app/RoundTripTest.kt', content: content.replaceAll('READ_ID', read).replaceAll('findById', read) }]
}

// Rust: the same, in tokio tests

const RUST_SHOP = `//! What no other test of the project says.

use mongodb::bson::{Bson, Document, doc};
use CRATE::bson_values;
use CRATE::database::Db;
use CRATE::entities::order::OrderLine;
use CRATE::errors::DomainError;
use CRATE::unit_of_work::{MongoUnitOfWork, UnitOfWork};

use super::{database, factories};

async fn stored(collection: &str) -> Option<Document> {
    database::connect().await.collection::<Document>(collection).find_one(doc! {}).await.expect("a read")
}

#[tokio::test]
async fn keeps_every_value_and_its_type() {
    let (_turn, uow) = database::open().await;
    let mut product = uow.products().insert(factories::new_product(1)).await.expect("a product");
    let id = product.id.clone().expect("id");
    let found = uow.products().READ_ID(id.clone()).await.expect("a read").expect("the row");
    assert_eq!(product, found);
    product.related = Some(vec!["0123456789abcdef01234567".to_string()]);
    uow.products().update(product.clone()).await.expect("an update");
    assert_eq!(product.related, uow.products().READ_ID(id).await.expect("a read").expect("the row").related);
    let document = stored("products").await.expect("a document");
    assert!(matches!(document.get("_id"), Some(Bson::ObjectId(_))));
    assert!(matches!(document.get("price"), Some(Bson::Decimal128(_))));
    assert!(matches!(document.get("reference"), Some(Bson::Binary(binary)) if binary.subtype == mongodb::bson::spec::BinarySubtype::Uuid));
    assert!(matches!(document.get_array("related").expect("a list")[0], Bson::ObjectId(_)));
    let order = factories::add_order(&uow, 2).await;
    let read = uow.orders().READ_ID(order.id.clone().expect("id")).await.expect("a read").expect("the row");
    assert_eq!(order.lines, read.lines);
    assert_eq!(order.notes, read.notes);
    let document = stored("orders").await.expect("a document");
    let line = document.get_array("lines").expect("a list")[0].as_document().expect("a line").clone();
    assert!(matches!(line.get("_id"), Some(Bson::ObjectId(_))));
    assert!(matches!(line.get("product"), Some(Bson::ObjectId(_))));
    assert!(matches!(line.get("price"), Some(Bson::Decimal128(_))));
    let customer = factories::add_customer(&uow, 5).await;
    let other = uow.customers().READ_ID(customer.id.clone().expect("id")).await.expect("a read").expect("the row");
    assert_eq!(customer.address, other.address);
    assert_eq!(customer.preferences, other.preferences);
    assert_eq!(customer.extra, other.extra);
}

#[tokio::test]
async fn changes_only_what_is_different() {
    let (_turn, uow) = database::open().await;
    let mut inserted = factories::add_customer(&uow, 1).await;
    let id = inserted.id.clone().expect("id");
    let target = database::connect().await.collection::<Document>("customers");
    target.update_one(doc! {}, doc! { "$set": { "unknown": 1, "address.unknown": 2 } }).await.expect("a change");
    let mut one = uow.customers().READ_ID(id.clone()).await.expect("a read").expect("the row");
    let mut other = uow.customers().READ_ID(id.clone()).await.expect("a read").expect("the row");
    one.name = Some("one".to_string());
    other.level = Some("gold".to_string());
    other.address.as_mut().expect("address").city = Some("Madrid".to_string());
    other.password_hash = None;
    uow.customers().update(one).await.expect("an update");
    uow.customers().update(other).await.expect("an update");
    let document = stored("customers").await.expect("a document");
    assert_eq!(document.get_str("name").ok(), Some("one"));
    assert_eq!(document.get_str("level").ok(), Some("gold"));
    assert_eq!(document.get_i32("unknown").ok(), Some(1));
    let address = document.get_document("address").expect("an address");
    assert_eq!(address.get_str("city").ok(), Some("Madrid"));
    assert_eq!(address.get_i32("unknown").ok(), Some(2));
    assert!(!document.contains_key("passwordHash"));
    // The entity an insert gives changes only its fields too
    inserted.name = Some("again".to_string());
    uow.customers().update(inserted).await.expect("an update");
    let document = stored("customers").await.expect("a document");
    assert_eq!((document.get_str("name").ok(), document.get_str("level").ok()), (Some("again"), Some("gold")));
}

#[tokio::test]
async fn does_not_undo_what_others_change_in_a_list() {
    let (_turn, uow) = database::open().await;
    let id = factories::add_order(&uow, 1).await.id.expect("id");
    let mut mine = uow.orders().READ_ID(id.clone()).await.expect("a read").expect("the row");
    let repository = uow.orders();
    let add = |n| repository.add_line(id.clone(), factories::new_order_line(n));
    let (a, b, c) = tokio::join!(add(0), add(1), add(2));
    for added in [a, b, c] {
        added.expect("a write").expect("the row");
    }
    mine.number = Some(99.0);
    uow.orders().update(mine).await.expect("an update");
    let found = uow.orders().READ_ID(id.clone()).await.expect("a read").expect("the row");
    let lines = found.lines.expect("lines");
    assert_eq!(4, lines.len());
    for line in &lines[1..] {
        uow.orders().remove_line(id.clone(), line.id.clone().expect("id")).await.expect("a write").expect("the row");
    }
    assert_eq!(1, uow.orders().READ_ID(id.clone()).await.expect("a read").expect("the row").lines.expect("lines").len());
    assert!(uow.orders().add_line("f".repeat(24), OrderLine::default()).await.expect("a write").is_none());
    assert!(uow.orders().READ_ID("nothing".to_string()).await.expect("a read").is_none());
    assert!(uow.orders().add_line("nothing".to_string(), OrderLine::default()).await.expect("a write").is_none());
    assert!(uow.orders().remove_line(id, "nothing".to_string()).await.expect("a write").is_none());
}

#[tokio::test]
async fn refuses_repeated_and_wrong_values() {
    let (_turn, uow) = database::open().await;
    factories::add_customer(&uow, 1).await;
    assert!(matches!(uow.customers().insert(factories::new_customer(1)).await, Err(DomainError::Conflict { .. })));
    // A document with a value of another type is not read as if it had none
    assert!(bson_values::read(&doc! { "a": "text" }, "a", bson_values::as_f64).is_err());
    assert_eq!(bson_values::read(&doc! { "a": 2 }, "a", bson_values::as_f64).expect("a number"), Some(2.0));
}
TRANSACTION
#[tokio::test]
async fn creates_nothing_in_the_database() {
    let (_turn, _uow) = database::open().await;
    let database = database::connect().await;
    database.drop().await.expect("no database");
    let other = MongoUnitOfWork::new(database.clone());
    assert!(other.customers().READ_ID("f".repeat(24)).await.expect("a read").is_none());
    let db = Db { database: database.clone(), session: None };
    assert_eq!(0, db.count("customers", doc! {}).await.expect("a count"));
    assert!(database.list_collection_names().await.expect("the names").is_empty());
}
`

const RUST_TRANSACTION = `
#[tokio::test]
async fn undoes_a_transaction_that_is_not_committed() {
    let (_turn, uow) = database::open().await;
    let inside = uow.begin().await.expect("a transaction");
    let mut customer = factories::add_customer(inside.as_ref(), 1).await;
    customer.name = Some("changed".to_string());
    inside.customers().update(customer).await.expect("an update");
    drop(inside);
    assert!(stored("customers").await.is_none());
    let inside = uow.begin().await.expect("a transaction");
    let joined = inside.begin().await.expect("the same transaction");
    factories::add_customer(joined.as_ref(), 1).await;
    joined.commit().await.expect("nothing yet");
    assert!(stored("customers").await.is_none());
    inside.commit().await.expect("a commit");
    assert!(stored("customers").await.is_some());
}
`

const RUST_CLINIC = `//! What no other test of the project says.

use mongodb::bson::{Document, doc};
use CRATE::entities::patient::PatientContact;
use CRATE::errors::DomainError;
use CRATE::unit_of_work::UnitOfWork;

use super::{database, factories};

#[tokio::test]
async fn fits_the_validators_of_the_collections() {
    let (_turn, uow) = database::open().await;
    let target = database::connect().await;
    // The collections with the validators of their own script, as a command of the server
VALIDATORS
    let patient = uow.patients().insert(factories::new_patient(1)).await.expect("a patient");
    let id = patient.id.clone().expect("id");
    let mut found = uow.patients().find_by_id(id.clone()).await.expect("a read").expect("the row");
    assert_eq!(patient.birth, found.birth);
    assert_eq!(patient.balance, found.balance);
    let mut room = factories::add_room(&uow, 1).await;
    found.weight = Some(70.0);
    found.balance = None;
    found.visits = Some(3);
    found.contacts.as_mut().expect("contacts").push(PatientContact {
        kind: Some("email".to_string()),
        value: Some("a@b.c".to_string()),
        ..Default::default()
    });
    room.beds = Some(4);
    uow.patients().update(found).await.expect("an update");
    uow.rooms().update(room.clone()).await.expect("an update");
    let changed = uow.patients().find_by_id(id.clone()).await.expect("a read").expect("the row");
    assert_eq!((Some(70.0), None, Some(3), 2), (changed.weight, changed.balance, changed.visits, changed.contacts.expect("contacts").len()));
    assert_eq!(Some(4), uow.rooms().find_by_id(room.id.expect("id")).await.expect("a read").expect("the row").beds);
    assert!(matches!(uow.patients().insert(factories::new_patient(1)).await, Err(DomainError::Conflict { .. })));
    factories::add_patient(&uow, 2).await;
    // What only the validator of the collection knows is refused too
    let mut wrong = factories::new_patient(3);
    wrong.blood = Some("Z".to_string());
    assert!(matches!(uow.patients().insert(wrong).await, Err(DomainError::Conflict { .. })));
    let fax = PatientContact { kind: Some("fax".to_string()), value: Some(String::new()), ..Default::default() };
    assert!(matches!(uow.patients().add_contact(id, fax).await, Err(DomainError::Conflict { .. })));
    let _: Option<Document> = target.collection("patients").find_one(doc! {}).await.expect("a read");
}
`

/** A value as the doc! macro of Rust writes it. */
const rustDoc = (value) =>
  Array.isArray(value)
    ? `[${value.map(rustDoc).join(', ')}]`
    : value && typeof value === 'object'
      ? `{ ${Object.entries(value).map(([name, item]) => `${JSON.stringify(name)}: ${rustDoc(item)}`).join(', ')} }`
      : JSON.stringify(value)

export function withRustRoundTrip(files, settings, code) {
  if (settings.architecture === 'table') return files
  const read = settings.verbs === 'get' ? 'get_by_id' : 'find_by_id'
  const name = /^name = "(.*)"$/m.exec(files.find((file) => file.path === 'Cargo.toml').content)[1]
  const commands = Object.entries(clinicValidators()).map(
    ([collection, validator]) =>
      `    let command = doc! { "collMod": ${JSON.stringify(collection)}, "validator": ${rustDoc(validator)}, "validationAction": "error" };\n    target.run_command(command).await.expect("a validator");`,
  )
  const content = code.endsWith('shop.ts')
    ? RUST_SHOP.replace('TRANSACTION', () => (settings.transactions === 'operation' ? RUST_TRANSACTION : ''))
    : RUST_CLINIC.replace('VALIDATORS', () => commands.join('\n'))
  return [
    ...files.map((file) => (file.path === 'tests/data/main.rs' ? { ...file, content: `${file.content}mod round_trip;\n` } : file)),
    { path: 'tests/data/round_trip.rs', content: content.replaceAll('READ_ID', read).replaceAll('CRATE', name.replaceAll('-', '_')) },
  ]
}

// Swift: the same, in swift-testing

const SWIFT_SHOP = `import Foundation
import MongoKitten
import Testing
@testable import MODULE

extension DataTests {
    /// What no other test of the project says.
    @Suite struct RoundTripTests {
        private func stored(_ uow: MongoUnitOfWork, _ collection: String) async throws -> BsonDocument? {
            try await uow.db.find(collection, [:], limit: 1).first
        }

        @Test func keepsEveryValueAndItsType() async throws {
            try await TestDatabase.with { uow in
                var product = try await uow.products.insert(Factories.newProduct(1))
                let found = try await uow.products.READ_ID(product.id!)
                #expect(found == product)
                product.related = ["0123456789abcdef01234567"]
                try await uow.products.update(product)
                let related = try await uow.products.READ_ID(product.id!)?.related
                #expect(related == product.related)
                let document = try #require(try await stored(uow, "products"))
                #expect(document["_id"] is ObjectId)
                #expect(document["price"] is Decimal128)
                #expect((document["reference"] as? Binary)?.data.count == 16)
                #expect((document["related"] as? BsonDocument)?["0"] is ObjectId)
                let order = try await Factories.addOrder(uow, 2)
                let read = try await uow.orders.READ_ID(order.id!)
                #expect(read?.lines == order.lines)
                #expect(read?.notes == order.notes)
                let lines = try await stored(uow, "orders")?["lines"] as? BsonDocument
                let line = try #require(lines?["0"] as? BsonDocument)
                #expect(line["_id"] is ObjectId)
                #expect(line["product"] is ObjectId)
                #expect(line["price"] is Decimal128)
                let customer = try await Factories.addCustomer(uow, 5)
                let other = try await uow.customers.READ_ID(customer.id!)
                #expect(other?.address == customer.address)
                #expect(other?.preferences == customer.preferences)
                #expect(other?.extra == customer.extra)
            }
        }

        @Test func keepsNumbersAndMoments() async throws {
            try await TestDatabase.with { uow in
                let texts = ["0", "-1", "0.01", "-12345.6789", "9999999999999999999999999999999999", "12345678901234567890.12345678901234", "1000000"]
                for text in texts {
                    let decimal = Decimal(string: text)!
                    let read = try Bson.asDecimal(try Bson.ofDecimal(decimal))
                    #expect(read == decimal)
                }
                // As the server writes it, and as it reads it
                let reply = try await uow.db.run([
                    "aggregate": 1, "cursor": [:] as BsonDocument,
                    "pipeline": [
                        ["$documents": [["a": try Bson.ofDecimal(Decimal(string: "-12.50")!)] as BsonDocument] as BsonDocument] as BsonDocument,
                        ["$project": ["text": ["$toString": "$a"] as BsonDocument, "half": ["$divide": ["$a", 4] as BsonDocument] as BsonDocument] as BsonDocument] as BsonDocument,
                    ] as BsonDocument,
                ])
                let batch = (reply["cursor"] as? BsonDocument)?["firstBatch"] as? BsonDocument
                let row = try #require(batch?["0"] as? BsonDocument)
                #expect(row["text"] as? String == "-12.5")
                let half = try row["half"].map(Bson.asDecimal)
                #expect(half == Decimal(string: "-3.125"))
                for millis in [1_767_268_800_123, 1_767_268_800_001, 999, -1500, -1] {
                    let document: BsonDocument = ["d": try Bson.ofDate(Date(timeIntervalSince1970: Double(millis) / 1000))]
                    let date = try document["d"].map(Bson.asDate)
                    #expect((date!.timeIntervalSince1970 * 1000).rounded() == Double(millis))
                }
            }
        }

        @Test func changesOnlyWhatIsDifferent() async throws {
            try await TestDatabase.with { uow in
                var inserted = try await Factories.addCustomer(uow, 1)
                let id = inserted.id!
                try await uow.db.update("customers", [:], ["$set": ["unknown": 1, "address.unknown": 2] as BsonDocument])
                let first = try await uow.customers.READ_ID(id)
                var one = try #require(first)
                var other = one
                one.name = "one"
                other.level = "gold"
                other.address?.city = "Madrid"
                other.passwordHash = nil
                try await uow.customers.update(one)
                try await uow.customers.update(other)
                var document = try #require(try await stored(uow, "customers"))
                #expect(document["name"] as? String == "one")
                #expect(document["level"] as? String == "gold")
                #expect(document["unknown"] as? Int == 1)
                let address = document["address"] as? BsonDocument
                #expect(address?["city"] as? String == "Madrid")
                #expect(address?["unknown"] as? Int == 2)
                #expect(document["passwordHash"] == nil)
                // The entity an insert gives changes only its fields too
                inserted.name = "again"
                try await uow.customers.update(inserted)
                document = try #require(try await stored(uow, "customers"))
                #expect(document["name"] as? String == "again")
                #expect(document["level"] as? String == "gold")
            }
        }

        @Test func doesNotUndoWhatOthersChangeInAList() async throws {
            try await TestDatabase.with { uow in
                let id = try await Factories.addOrder(uow, 1).id!
                let read = try await uow.orders.READ_ID(id)
                var mine = try #require(read)
                try await withThrowingTaskGroup(of: Void.self) { group in
                    for n in 0..<4 { group.addTask { _ = try await uow.orders.addLine(id, Factories.newOrderLine(n)) } }
                    try await group.waitForAll()
                }
                mine.number = 99
                try await uow.orders.update(mine)
                let found = try await uow.orders.READ_ID(id)
                let lines = try #require(found?.lines)
                #expect(lines.count == 5)
                for line in lines.dropFirst() { _ = try await uow.orders.removeLine(id, line.id!) }
                #expect(try await uow.orders.READ_ID(id)?.lines?.count == 1)
                #expect(try await uow.orders.addLine(String(repeating: "f", count: 24), Order.Line()) == nil)
                #expect(try await uow.orders.READ_ID("nothing") == nil)
                #expect(try await uow.orders.addLine("nothing", Order.Line()) == nil)
                #expect(try await uow.orders.removeLine(id, "nothing") == nil)
            }
        }

        @Test func refusesRepeatedAndWrongValues() async throws {
            try await TestDatabase.with { uow in
                try await Factories.addCustomer(uow, 1)
                #expect(isConflict(await refusal { try await Factories.addCustomer(uow, 1) }))
                // A document with a value of another type is not read as if it had none
                #expect(throws: BsonError.self) { try Bson.read(["a": "text"], "a", Bson.asDouble) }
                #expect(try Bson.read(["a": Int32(2)], "a", Bson.asDouble) == 2)
            }
        }

        @Test func readsAllTheDocumentsOfACursor() async throws {
            try await TestDatabase.with { uow in
                for n in 0..<300 { try await uow.db.insert("many", ["n": n]) }
                #expect(try await uow.db.find("many", [:]).count == 300)
                #expect(try await uow.db.count("many", [:]) == 300)
            }
        }
TRANSACTION
        @Test func createsNothingInTheDatabase() async throws {
            try await TestDatabase.with { uow in
                try await uow.db.run(["dropDatabase": 1])
                let app = try await AppDatabase(url: ProcessInfo.processInfo.environment["TEST_DATABASE_URL"]!)
                let other = MongoUnitOfWork(db: app.database)
                let found = try await other.customers.READ_ID(String(repeating: "f", count: 24))
                await app.shutdown()
                #expect(found == nil)
                let reply = try await uow.db.run(["listCollections": 1])
                let names = (reply["cursor"] as? BsonDocument)?["firstBatch"] as? BsonDocument
                #expect(names?.isEmpty == true)
            }
        }
    }
}
`

const SWIFT_TRANSACTION = `
        @Test func undoesATransactionThatFails() async throws {
            struct Stop: Error {}
            try await TestDatabase.with { uow in
                await #expect(throws: Stop.self) {
                    try await uow.transaction { inside in
                        var customer = try await Factories.addCustomer(inside, 1)
                        customer.name = "changed"
                        try await inside.customers.update(customer)
                        #expect(try await inside.customers.READ_ID(customer.id!)?.name == "changed")
                        let refused = await refusal { try await Factories.addCustomer(inside, 1) }
                        #expect(isConflict(refused))
                        throw Stop()
                    }
                }
                #expect(try await stored(uow, "customers") == nil)
                try await uow.transaction { inside in
                    try await Factories.addCustomer(inside, 1)
                    try await inside.transaction { joined in _ = try await Factories.addCustomer(joined, 2) }
                }
                #expect(try await uow.db.count("customers", [:]) == 2)
                // A cursor longer than a batch, and a count, inside a transaction
                for n in 0..<300 { try await uow.db.insert("many", ["n": n]) }
                let counts = try await uow.db.transaction { inside in
                    [try await inside.find("many", [:]).count, try await inside.count("many", [:])]
                }
                #expect(counts == [300, 300])
            }
        }
`

const SWIFT_CLINIC = `import Foundation
import MongoKitten
import Testing
@testable import MODULE

extension DataTests {
    /// What no other test of the project says.
    @Suite struct RoundTripTests {
        @Test func fitsTheValidatorsOfTheCollections() async throws {
            try await TestDatabase.with { uow in
                // The collections with the validators of their own script, as a command of the server
VALIDATORS
                let patient = try await uow.patients.insert(Factories.newPatient(1))
                let read = try await uow.patients.findById(patient.id!)
                var found = try #require(read)
                #expect(found.birth == patient.birth)
                #expect(found.balance == patient.balance)
                var room = try await Factories.addRoom(uow, 1)
                found.weight = 70
                found.balance = nil
                found.visits = 3
                found.contacts?.append(Patient.Contact(kind: "email", value: "a@b.c"))
                room.beds = 4
                try await uow.patients.update(found)
                try await uow.rooms.update(room)
                let again = try await uow.patients.findById(patient.id!)
                let changed = try #require(again)
                #expect(changed.weight == 70)
                #expect(changed.balance == nil)
                #expect(changed.visits == 3)
                #expect(changed.contacts?.count == 2)
                #expect(try await uow.rooms.findById(room.id!)?.beds == 4)
                #expect(isConflict(await refusal { try await uow.patients.insert(Factories.newPatient(1)) }))
                try await Factories.addPatient(uow, 2)
                // What only the validator of the collection knows is refused too
                var wrong = Factories.newPatient(3)
                wrong.blood = "Z"
                let refused = wrong
                #expect(isConflict(await refusal { try await uow.patients.insert(refused) }))
                #expect(isConflict(await refusal { try await uow.patients.addContact(patient.id!, Patient.Contact(kind: "fax", value: "")) }))
            }
        }
    }
}
`

/** A value as a literal of a document in Swift. */
const swiftDoc = (value) =>
  Array.isArray(value)
    ? `[${value.map(swiftDoc).join(', ')}] as BsonDocument`
    : value && typeof value === 'object'
      ? `[${Object.entries(value).map(([name, item]) => `${JSON.stringify(name)}: ${swiftDoc(item)}`).join(', ') || ':'}] as BsonDocument`
      : JSON.stringify(value)

export function withSwiftRoundTrip(files, settings, code) {
  if (settings.architecture === 'table') return files
  const read = settings.verbs === 'get' ? 'getById' : 'findById'
  const module = /\.library\(name: "(\w+)"/.exec(files.find((file) => file.path === 'Package.swift').content)[1]
  const commands = Object.entries(clinicValidators()).map(
    ([collection, validator], index) =>
      `                let validator${index}: BsonDocument = ${swiftDoc(validator)}\n                try await uow.db.run(["collMod": ${JSON.stringify(collection)}, "validator": validator${index}, "validationAction": "error"])`,
  )
  const content = code.endsWith('shop.ts')
    ? SWIFT_SHOP.replace('TRANSACTION', () => (settings.transactions === 'operation' ? SWIFT_TRANSACTION : ''))
    : SWIFT_CLINIC.replace('VALIDATORS', () => commands.join('\n'))
  return [
    ...files,
    { path: `Tests/${module}Tests/RoundTripTests.swift`, content: content.replaceAll('READ_ID', read).replaceAll('MODULE', module) },
  ]
}
