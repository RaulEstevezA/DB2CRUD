// The documents of the application
use('app')
db.countries.insertMany([
  { _id: 'es', id: 34, name: "Spain" },
  { _id: 'fr', id: 33, name: `France`, borders: ['es'] },
])
db.audit.entries.insertOne({ what: 'start', when: new Date(), level: NumberInt(2) })
