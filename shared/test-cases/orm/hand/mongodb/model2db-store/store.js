// MongoDB collections written by Model2DB from Order. Run it with mongosh.
// Review it before running it: nothing here has been run.

// TODO: decide how "Order.lines.product" is stored (pending in the design).
db.createCollection("orders", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "customer", "status", "lines", "tags", "placed_at"],
    properties: {
      _id: {
        bsonType: "long",
      },
      customer: {
        bsonType: "object",
        required: ["id", "email", "full_name", "shipping_address", "created_at"],
        properties: {
          id: {
            bsonType: "double",
          },
          email: {
            bsonType: "string",
          },
          full_name: {
            bsonType: "string",
          },
          phone: {
            bsonType: "string",
          },
          shipping_address: {
            bsonType: "object",
            required: ["street", "city", "postal_code", "country"],
            properties: {
              street: {
                bsonType: "string",
              },
              city: {
                bsonType: "string",
              },
              postal_code: {
                bsonType: "string",
              },
              country: {
                bsonType: "string",
              },
            },
            additionalProperties: false,
          },
          created_at: {
            bsonType: "date",
          },
        },
        additionalProperties: false,
      },
      status: {
        enum: ["draft", "paid", "shipped", "cancelled"],
      },
      lines: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["quantity", "unit_price"],
          properties: {
            quantity: {
              bsonType: "double",
            },
            unit_price: {
              bsonType: "double",
            },
          },
          additionalProperties: false,
        },
      },
      coupon_code: {
        bsonType: ["string", "null"],
      },
      tags: {
        bsonType: "array",
        items: {
          bsonType: "string",
        },
      },
      placed_at: {
        bsonType: "date",
      },
    },
    additionalProperties: false,
  } },
})

db.createCollection("products", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "sku", "name", "price", "categories", "attributes"],
    properties: {
      _id: {
        bsonType: "long",
      },
      sku: {
        bsonType: "string",
      },
      name: {
        bsonType: "string",
      },
      price: {
        bsonType: "double",
      },
      categories: {
        bsonType: "array",
        items: {
          bsonType: "long",
        },
      },
      attributes: {
        bsonType: "object",
        additionalProperties: {
          bsonType: "string",
        },
      },
    },
    additionalProperties: false,
  } },
})

db.createCollection("categories", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["_id", "name", "products"],
    properties: {
      _id: {
        bsonType: "long",
      },
      name: {
        bsonType: "string",
      },
      products: {
        bsonType: "array",
        items: {
          bsonType: "long",
        },
      },
    },
    additionalProperties: false,
  } },
})
