export enum ProductStatus {
  Draft = 'draft',
  Live = 'live',
}

/** A customer of the shop */
export interface Customer {
  id: number
  email: string
  passwordHash: string
  readonly createdAt: Date
}

export interface CategoryDto {
  id: number
  name: string
}

export interface Product {
  id: number
  name: string
  price: string
  status: ProductStatus
  categoryName: string
  tagIds: number[]
  description?: string
}

export class TagEntity {
  id!: number
  label!: string
}
