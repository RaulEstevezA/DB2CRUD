// Mongoose schemas written by Model2DB from User. Review them before using them.
import { Schema, model } from 'mongoose'

const profileSchema = new Schema(
  {
    bio: { type: String, default: null },
    website: { type: String, default: null },
  },
  { _id: false },
)

const userSchema = new Schema(
  {
    _id: String,
    email: { type: String, required: true },
    name: { type: String, default: null },
    profile: { type: profileSchema, default: null },
    created_at: Date,
  },
  { collection: 'users', versionKey: false },
)
userSchema.index({ 'email': 1 }, { name: 'uq_users_email', unique: true })

const commentSchema = new Schema(
  {
    text: { type: String, required: true },
    written_at: { type: Date, required: true },
    rating: { type: Number, default: null },
  },
  { _id: false },
)

const postSchema = new Schema(
  {
    _id: Number,
    title: { type: String, required: true },
    body: { type: String, required: true },
    published: Boolean,
    author_id: { type: String, required: true },
    comments: [commentSchema],
    tags: [String],
  },
  { collection: 'posts', versionKey: false },
)
postSchema.index({ 'author_id': 1 }, { name: 'ix_posts_author_id' })

export const User = model('User', userSchema)
export const Post = model('Post', postSchema)
