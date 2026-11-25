// A store kept in documents: what its validators say
db.createCollection("customers", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "email", "since", "address"],
    properties: {
      _id: { bsonType: "objectId" },
      email: { bsonType: "string" },
      level: { enum: ["basic", "gold"] },
      since: { bsonType: "date" },
      address: {
        bsonType: "object",
        required: ["street", "zip code"],
        properties: {
          street: { bsonType: "string" },
          "zip code": { bsonType: "string" },
          location: {
            bsonType: "object",
            required: ["latitude", "longitude"],
            properties: { latitude: { bsonType: "double" }, longitude: { bsonType: "double" } },
          },
        },
      },
      tags: { bsonType: "array", items: { bsonType: "string" } },
    },
  } },
})
db.customers.createIndex({ email: 1 }, { unique: true })

db.createCollection("orders", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "code", "lines"],
    properties: {
      _id: { bsonType: "objectId" },
      code: { bsonType: "string" },
      lines: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["sku", "quantity", "price"],
          properties: {
            _id: { bsonType: "objectId" },
            sku: { bsonType: "string" },
            quantity: { bsonType: "int" },
            price: { bsonType: "decimal" },
            status: { enum: ["pending", "sent"] },
            discounts: {
              bsonType: "array",
              items: {
                bsonType: "object",
                required: ["reason", "percent"],
                properties: { reason: { bsonType: "string" }, percent: { bsonType: "double" } },
              },
            },
          },
        },
      },
      shipping: {
        bsonType: "object",
        required: ["carrier", "sentOn"],
        properties: { carrier: { bsonType: "string" }, sentOn: { bsonType: "date" } },
      },
    },
  } },
})
db.orders.createIndex({ code: 1 }, { unique: true })

// Its application model says less than its documents, and keeps some of them in another way
db.createCollection("shipments", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "parcel"],
    properties: {
      _id: { bsonType: "objectId" },
      parcel: {
        bsonType: "object",
        required: ["weight", "contents"],
        properties: {
          weight: { bsonType: "double" },
          contents: { bsonType: "string" },
          size: { bsonType: "object", required: ["height"], properties: { height: { bsonType: "double" } } },
        },
      },
      stops: { bsonType: "array", items: { bsonType: "object", properties: { city: { bsonType: "string" } } } },
    },
  } },
})
