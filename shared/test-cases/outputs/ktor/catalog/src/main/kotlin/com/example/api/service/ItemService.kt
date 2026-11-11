package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.ItemCreate
import com.example.api.dto.ItemUpdate
import com.example.api.model.Item
import com.example.api.repository.CategoryRepository
import com.example.api.repository.ItemRepository

/** Rules of items: what each operation checks and changes. */
class ItemService(
    private val repository: ItemRepository,
    private val categoryRepository: CategoryRepository,
) {
    private suspend fun find(key: Long): Item =
        repository.get(key) ?: throw ApiException.notFound("item")

    /** Every reference must point to a stored item. */
    private suspend fun checkReferences(item: Item) {
        item.categoryId?.let { reference0 ->
            if (categoryRepository.get(reference0) == null) throw ApiException.invalid("categoryId", "No Category has this key")
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Item, body: Body<ItemCreate>) {
        val data = body.value
        item.name = data.name
        item.price = data.price
        item.supplierEmail = data.supplierEmail
        item.categoryId = data.categoryId
        item.stock = data.stock
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Item, body: Body<ItemUpdate>) {
        val data = body.value
        if (body.has("name")) item.name = data.name
        if (body.has("price")) item.price = data.price
        if (body.has("supplierEmail")) item.supplierEmail = data.supplierEmail
        if (body.has("categoryId")) item.categoryId = data.categoryId
        if (body.has("stock")) item.stock = data.stock
    }

    /** List items. */
    suspend fun listItems(query: ListQuery): ListResult<Item> = repository.list(query)

    /** Get an item. */
    suspend fun getItem(key: Long): Item = find(key)

    /** Create an item. */
    suspend fun createItem(body: Body<ItemCreate>): Item {
        val item = Item()
        apply(item, body)
        checkReferences(item)
        return repository.add(item)
    }

    /** Replace an item: every field the client may send takes the value of the body. */
    suspend fun replaceItem(key: Long, body: Body<ItemCreate>): Item {
        val item = find(key)
        apply(item, body)
        checkReferences(item)
        return repository.update(item)
    }

    /** Update part of an item: only the fields in the body change. */
    suspend fun updateItem(key: Long, body: Body<ItemUpdate>): Item {
        val item = find(key)
        applyChanges(item, body)
        checkReferences(item)
        return repository.update(item)
    }

    /** Delete an item. */
    suspend fun deleteItem(key: Long) {
        find(key)
        repository.delete(key)
    }
}
