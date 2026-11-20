export enum OrderStatus {
  Open = 'open',
  Shipped = 'shipped',
}

/** Read and written: the entity of the table */
export interface Customer {
  id: number
  email: string
  fullName?: string
}

/** Only read */
export interface CustomerResponse {
  id: number
  email: string
  createdAt: Date
}

/** Two models that only write the same table: one is chosen for review */
export interface ProductInput {
  name: string
  price: string
}

export interface ProductCommand {
  name: string
}

/** Only written: the customer is looked up by email, the total is computed by the database */
export interface OrderRequest {
  customerEmail: string
  quantity: number
  unitPrice: string
}

/** Only read: the column keeps a status the model does not know, and may have no shipping date */
export interface OrderResponse {
  id: number
  status: OrderStatus
  total: string | null
  shippedAt: Date
}
