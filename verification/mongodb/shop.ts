import mongoose, { Schema, model, type InferSchemaType } from 'mongoose'

const addressSchema = new Schema(
  {
    street: { type: String, required: true },
    city: { type: String, required: [true, 'A city is needed'] },
    'zip code': String,
    location: { type: { type: String, enum: ['Point'] }, coordinates: [Number] },
  },
  { _id: false },
)

const customerSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, maxlength: 120 },
    name: { type: String, required: true, minlength: 2 },
    passwordHash: String,
    active: { type: Boolean, default: true },
    level: { type: String, enum: ['basic', 'gold'], default: 'basic' },
    address: addressSchema,
    tags: [String],
    preferences: { theme: { type: String, default: 'light' }, newsletter: Boolean },
    extra: Schema.Types.Mixed,
    deletedAt: Date,
  },
  { timestamps: true },
)

const productSchema: Schema = new Schema({
  sku: { type: String, required: true, unique: true },
  title: { type: String, required: true, index: true },
  price: { type: Schema.Types.Decimal128, required: true },
  stock: { type: Number, default: 0, min: 0 },
  reference: { type: Schema.Types.UUID },
  picture: Buffer,
  related: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
})

const lineSchema = new Schema({
  product: { type: mongoose.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: mongoose.Schema.Types.Decimal128, required: true },
  status: { type: String, enum: ['pending', 'sent'], default: 'pending' },
})

const orderSchema = new Schema({
  number: { type: Number, required: true },
  year: { type: Number, required: true },
  customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  lines: { type: [lineSchema], required: true },
  notes: [{ text: String, at: Date }],
  placedAt: { type: Date, default: Date.now },
})
orderSchema.index({ year: 1, number: 1 }, { unique: true })
orderSchema.index({ 'lines.product': 1 })

// A key of its own, and the id of another system
const countrySchema = new Schema({ _id: String, id: { type: Number, unique: true, required: true }, name: { type: String, required: true } }, { collection: 'countries' })

export type Customer = InferSchemaType<typeof customerSchema>
export const CustomerModel = model('Customer', customerSchema)
export const ProductModel = mongoose.model('Product', productSchema)
export const OrderModel = model<unknown>('Order', orderSchema)
export const CountryModel = model('Country', countrySchema)
