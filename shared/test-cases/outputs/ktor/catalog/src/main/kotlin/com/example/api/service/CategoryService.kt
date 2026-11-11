package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.CategoryCreate
import com.example.api.dto.CategoryUpdate
import com.example.api.model.Category
import com.example.api.repository.CategoryRepository

/** Rules of categories: what each operation checks and changes. */
class CategoryService(
    private val repository: CategoryRepository,
) {
    private suspend fun find(key: Long): Category =
        repository.get(key) ?: throw ApiException.notFound("category")

    /** Every reference must point to a stored item. */
    private suspend fun checkReferences(item: Category) {
        item.parentId?.let { reference0 ->
            if (repository.get(reference0) == null) throw ApiException.invalid("parentId", "No Category has this key")
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Category, body: Body<CategoryCreate>) {
        val data = body.value
        item.name = data.name
        item.parentId = data.parentId
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Category, body: Body<CategoryUpdate>) {
        val data = body.value
        if (body.has("name")) item.name = data.name
        if (body.has("parentId")) item.parentId = data.parentId
    }

    /** List categories. */
    suspend fun listCategories(query: ListQuery): ListResult<Category> = repository.list(query)

    /** Get a category. */
    suspend fun getCategory(key: Long): Category = find(key)

    /** Create a category. */
    suspend fun createCategory(body: Body<CategoryCreate>): Category {
        val item = Category()
        apply(item, body)
        checkReferences(item)
        return repository.add(item)
    }

    /** Replace a category: every field the client may send takes the value of the body. */
    suspend fun replaceCategory(key: Long, body: Body<CategoryCreate>): Category {
        val item = find(key)
        apply(item, body)
        checkReferences(item)
        return repository.update(item)
    }

    /** Update part of a category: only the fields in the body change. */
    suspend fun updateCategory(key: Long, body: Body<CategoryUpdate>): Category {
        val item = find(key)
        applyChanges(item, body)
        checkReferences(item)
        return repository.update(item)
    }

    /** Delete a category. */
    suspend fun deleteCategory(key: Long) {
        find(key)
        repository.delete(key)
    }
}
