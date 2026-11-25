export enum Level {
  Basic = 'basic',
  Gold = 'gold',
}

export enum LineStatus {
  Pending = 'pending',
  Sent = 'sent',
}

export interface Location {
  latitude: number
  longitude: number
}

export interface Address {
  street: string
  zipCode: string
  location?: Location
}

export interface Customer {
  id: string
  email: string
  level?: Level
  since: Date
  address: Address
  tags: string[]
}

export interface Discount {
  reason: string
  percent: number
}

export interface OrderLine {
  id?: string
  sku: string
  quantity: number
  price: string
  status: LineStatus | null
  discounts: Discount[]
}

export interface Shipping {
  carrier: string
  sentOn: Date
}

export interface Order {
  id: string
  code: string
  lines: OrderLine[]
  shipping: Shipping | null
}

export interface Parcel {
  weight: number
  size: string
  fragile: boolean
}

export interface Shipment {
  id: string
  parcel: Parcel
  stops: string[]
}
