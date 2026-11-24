// MongoDB collections written by Model2DB from Invoice. Run it with mongosh.
// Review it before running it: nothing here has been run.

db.createCollection("invoices", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "number", "issued_at", "currency", "paid", "customer", "lines", "labels"],
    properties: {
      _id: {
        bsonType: "int",
      },
      number: {
        bsonType: "string",
      },
      issued_at: {
        bsonType: "date",
      },
      currency: {
        bsonType: "string",
      },
      paid: {
        bsonType: "bool",
      },
      customer: {
        bsonType: "object",
        required: ["customer_id", "name", "email", "billing_address"],
        properties: {
          customer_id: {
            bsonType: "int",
          },
          name: {
            bsonType: "string",
          },
          email: {
            bsonType: "string",
          },
          billing_address: {
            bsonType: "object",
            required: ["street", "city", "zip_code"],
            properties: {
              street: {
                bsonType: "string",
              },
              city: {
                bsonType: "string",
              },
              zip_code: {
                bsonType: "string",
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      lines: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["description", "qty", "unit_price", "tax_rate"],
          properties: {
            description: {
              bsonType: "string",
            },
            qty: {
              bsonType: "int",
            },
            unit_price: {
              bsonType: "double",
            },
            tax_rate: {
              bsonType: "double",
            },
          },
          additionalProperties: false,
        },
      },
      notes: {},
      labels: {
        bsonType: "array",
        items: {
          bsonType: "string",
        },
      },
    },
    additionalProperties: false,
  } },
})
