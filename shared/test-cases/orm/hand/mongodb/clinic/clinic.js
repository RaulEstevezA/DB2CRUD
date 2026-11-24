db.createCollection('patients', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      title: 'Patient',
      required: ['name', 'birth', 'contacts', 'visits'],
      properties: {
        name: { bsonType: 'string', minLength: 2, maxLength: 80, description: 'Full name' },
        birth: { bsonType: 'date' },
        weight: { bsonType: ['double', 'int', 'null'] },
        balance: { bsonType: 'decimal' },
        document: { bsonType: 'string' },
        photo: { bsonType: 'binData' },
        visits: { bsonType: 'int', minimum: 0 },
        blood: { enum: ['A', 'B', 'O'] },
        contacts: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['kind', 'value'],
            properties: { kind: { bsonType: 'string', enum: ['phone', 'email'] }, value: { bsonType: 'string' } },
          },
        },
        insurance: { bsonType: 'object', properties: { company: { bsonType: 'string' }, since: { bsonType: 'date' } } },
        version: { bsonType: 'int' },
      },
    },
  },
})
db.patients.createIndex({ document: 1 }, { unique: true, sparse: true, name: 'ux_document' })
db.getCollection('patients').createIndex({ birth: -1 })

db.createCollection('rooms', {
  validator: { $jsonSchema: { bsonType: 'object', required: ['code'], properties: { _id: { bsonType: 'objectId' }, code: { bsonType: 'string' }, beds: { bsonType: 'long' } } } },
})
