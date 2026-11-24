// MongoDB collections written by Model2DB from User. Run it with mongosh.
// Review it before running it: nothing here has been run.

db.createCollection("users", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "email"],
    properties: {
      _id: {
        bsonType: "string",
      },
      email: {
        bsonType: "string",
      },
      name: {
        bsonType: ["string", "null"],
      },
      profile: {
        bsonType: ["object", "null"],
        properties: {
          bio: {
            bsonType: ["string", "null"],
          },
          website: {
            bsonType: ["string", "null"],
          },
        },
        additionalProperties: false,
      },
      created_at: {
        bsonType: "date",
      },
    },
    additionalProperties: false,
  } },
})
db.getCollection("users").createIndex({ email: 1 }, { name: "uq_users_email", unique: true })

db.createCollection("posts", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "title", "body", "author_id", "comments", "tags"],
    properties: {
      _id: {
        bsonType: "int",
      },
      title: {
        bsonType: "string",
      },
      body: {
        bsonType: "string",
      },
      published: {
        bsonType: "bool",
      },
      author_id: {
        bsonType: "string",
      },
      comments: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["text", "written_at"],
          properties: {
            text: {
              bsonType: "string",
            },
            written_at: {
              bsonType: "date",
            },
            rating: {
              bsonType: ["int", "null"],
            },
          },
          additionalProperties: false,
        },
      },
      tags: {
        bsonType: "array",
        items: {
          bsonType: "string",
        },
      },
    },
    additionalProperties: false,
  } },
})
db.getCollection("posts").createIndex({ author_id: 1 }, { name: "ix_posts_author_id" })
