import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { Author, Comment, Post, Profile, Tag } from './entities/index.js'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [Author, Profile, Post, Comment, Tag],
  synchronize: false,
})
