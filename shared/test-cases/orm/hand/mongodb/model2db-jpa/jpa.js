// MongoDB collections written by Model2DB from Author. Run it with mongosh.
// Review it before running it: nothing here has been run.

db.createCollection("authors", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "name", "email"],
    properties: {
      _id: {
        bsonType: "long",
      },
      name: {
        bsonType: "string",
      },
      email: {
        bsonType: "string",
      },
    },
    additionalProperties: false,
  } },
})
db.getCollection("authors").createIndex({ email: 1 }, { name: "uq_authors_email", unique: true })

// TODO: does the application read "Book" by author, ordered by publishedOn desc? Accept the query in the design to index it.
db.createCollection("books", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "isbn", "title", "author", "price", "published_on", "genre", "shelf", "tags"],
    properties: {
      _id: {
        bsonType: "long",
      },
      isbn: {
        bsonType: "string",
      },
      title: {
        bsonType: "string",
      },
      author: {
        bsonType: "long",
      },
      price: {
        bsonType: "decimal",
      },
      published_on: {
        bsonType: "date",
      },
      genre: {
        enum: ["FICTION", "ESSAY", "POETRY", "SCIENCE"],
      },
      shelf: {
        bsonType: "object",
        required: ["room"],
        properties: {
          room: {
            bsonType: "string",
          },
          row: {
            bsonType: ["int", "null"],
          },
        },
        additionalProperties: false,
      },
      tags: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["code", "label"],
          properties: {
            code: {
              bsonType: "string",
            },
            label: {
              bsonType: "string",
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  } },
})
db.getCollection("books").createIndex({ isbn: 1 }, { name: "uq_books_isbn", unique: true })
db.getCollection("books").createIndex({ author: 1 }, { name: "ix_books_author" })
