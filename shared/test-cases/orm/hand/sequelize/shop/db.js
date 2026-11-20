const { Sequelize } = require('sequelize')

// One database for the whole shop; every model gets snake_case columns
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  define: { underscored: true },
})

module.exports = { sequelize }
