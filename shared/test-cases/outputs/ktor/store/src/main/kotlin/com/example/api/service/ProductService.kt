package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.ProductCreate
import com.example.api.dto.ProductUpdate
import com.example.api.model.Product
import com.example.api.repository.ProductRepository

/** Rules of products: what each operation checks and changes. */
class ProductService(
    private val repository: ProductRepository,
) {
    private suspend fun find(key: Long): Product =
        repository.get(key) ?: throw ApiException.notFound("product")

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Product, body: Body<ProductCreate>) {
        val data = body.value
        item.sku = data.sku
        item.name = data.name
        item.description = data.description
        item.price = data.price
        item.stock = data.stock
        item.active = data.active
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Product, body: Body<ProductUpdate>) {
        val data = body.value
        if (body.has("sku")) item.sku = data.sku
        if (body.has("name")) item.name = data.name
        if (body.has("description")) item.description = data.description
        if (body.has("price")) item.price = data.price
        if (body.has("stock")) item.stock = data.stock
        if (body.has("active")) item.active = data.active
    }

    /** List products. */
    suspend fun listProducts(query: ListQuery): ListResult<Product> = repository.list(query)

    /** Get a product. */
    suspend fun getProduct(key: Long): Product = find(key)

    /** Create a product. */
    suspend fun createProduct(body: Body<ProductCreate>): Product {
        val item = Product()
        apply(item, body)
        return repository.add(item)
    }

    /** Replace a product: every field the client may send takes the value of the body. */
    suspend fun replaceProduct(key: Long, body: Body<ProductCreate>): Product {
        val item = find(key)
        apply(item, body)
        return repository.update(item)
    }

    /** Update part of a product: only the fields in the body change. */
    suspend fun updateProduct(key: Long, body: Body<ProductUpdate>): Product {
        val item = find(key)
        applyChanges(item, body)
        return repository.update(item)
    }

    /** Delete a product. */
    suspend fun deleteProduct(key: Long) {
        find(key)
        repository.delete(key)
    }
}
