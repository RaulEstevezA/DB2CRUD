// Mongoose schemas written by Model2DB from Order. Review them before using them.
import { Schema, model } from 'mongoose'

const addressSchema = new Schema(
  {
    street: { type: String, required: true },
    city: { type: String, required: true },
    postal_code: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false },
)

const customerSchema = new Schema(
  {
    id: { type: Number, required: true },
    email: { type: String, required: true },
    full_name: { type: String, required: true },
    phone: String,
    shipping_address: { type: addressSchema, required: true },
    created_at: { type: Date, required: true },
  },
  { _id: false },
)

const orderLineSchema = new Schema(
  {
    quantity: { type: Number, required: true },
    unit_price: { type: Number, required: true },
  },
  { _id: false },
)

// TODO: decide how "Order.lines.product" is stored (pending in the design).
const orderSchema = new Schema(
  {
    _id: Number,
    customer: { type: customerSchema, required: true },
    status: { type: String, required: true, enum: ['draft', 'paid', 'shipped', 'cancelled'] },
    lines: [orderLineSchema],
    coupon_code: { type: String, default: null },
    tags: [String],
    placed_at: { type: Date, required: true },
  },
  { collection: 'orders', versionKey: false },
)

const productSchema = new Schema(
  {
    _id: Number,
    sku: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    categories: [{ type: Number, ref: 'Category' }],
    attributes: { type: Map, of: String },
  },
  { collection: 'products', versionKey: false },
)

const categorySchema = new Schema(
  {
    _id: Number,
    name: { type: String, required: true },
    products: [{ type: Number, ref: 'Product' }],
  },
  { collection: 'categories', versionKey: false },
)

export const Order = model('Order', orderSchema)
export const Product = model('Product', productSchema)
export const Category = model('Category', categorySchema)
