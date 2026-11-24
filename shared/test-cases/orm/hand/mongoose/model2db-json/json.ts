// Mongoose schemas written by Model2DB from Invoice. Review them before using them.
import { Schema, model } from 'mongoose'

const billingAddressSchema = new Schema(
  {
    street: { type: String, required: true },
    city: { type: String, required: true },
    zip_code: { type: String, required: true },
  },
  { _id: false },
)

const customerSchema = new Schema(
  {
    customer_id: { type: Number, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    billing_address: { type: billingAddressSchema, required: true },
  },
  { _id: false },
)

const lineSchema = new Schema(
  {
    description: { type: String, required: true },
    qty: { type: Number, required: true },
    unit_price: { type: Number, required: true },
    tax_rate: { type: Number, required: true },
  },
  { _id: false },
)

const invoiceSchema = new Schema(
  {
    _id: Number,
    number: { type: String, required: true },
    issued_at: { type: Date, required: true },
    currency: { type: String, required: true },
    paid: { type: Boolean, required: true },
    customer: { type: customerSchema, required: true },
    lines: [lineSchema],
    notes: Schema.Types.Mixed,
    labels: [String],
  },
  { collection: 'invoices', versionKey: false },
)

export const Invoice = model('Invoice', invoiceSchema)
