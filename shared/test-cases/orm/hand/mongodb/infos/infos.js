[
  {
    name: 'invoices',
    type: 'collection',
    options: {
      validator: {
        '$jsonSchema': {
          bsonType: 'object',
          required: [ 'number', 'lines' ],
          properties: {
            number: { bsonType: [ 'int', 'long' ] },
            paid: { type: 'boolean' },
            total: { bsonType: 'decimal', minimum: 0, exclusiveMinimum: true },
            lines: { bsonType: 'array', items: { bsonType: 'object', properties: { text: { bsonType: 'string' } } } },
            odd: { bsonType: 'regex' }
          }
        }
      },
      validationLevel: 'strict'
    },
    info: { readOnly: false, uuid: UUID('6c84fb90-12c4-11e1-840d-7b25c5ee775a') },
    idIndex: { v: 2, key: { _id: 1 }, name: '_id_' }
  },
  { name: 'logs', type: 'collection', options: {}, info: { readOnly: false } }
]
