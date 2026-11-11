package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.JsonUuid
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.BookCreate
import com.example.api.dto.BookUpdate
import com.example.api.model.Book
import com.example.api.repository.AuthorRepository
import com.example.api.repository.BookRepository

/** Rules of books: what each operation checks and changes. */
class BookService(
    private val repository: BookRepository,
    private val authorRepository: AuthorRepository,
) {
    private suspend fun find(key: JsonUuid): Book =
        repository.get(key) ?: throw ApiException.notFound("book")

    /** Every reference must point to a stored item. */
    private suspend fun checkReferences(item: Book) {
        item.authorId?.let { reference0 ->
            if (authorRepository.get(reference0) == null) throw ApiException.invalid("authorId", "No Author has this key")
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Book, body: Body<BookCreate>) {
        val data = body.value
        item.title = data.title
        item.isbn = data.isbn
        item.authorId = data.authorId
        item.genre = data.genre
        item.pages = data.pages
        item.published = if (body.has("published")) data.published else null
        item.available = if (body.has("available")) data.available else true
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Book, body: Body<BookUpdate>) {
        val data = body.value
        if (body.has("title")) item.title = data.title
        if (body.has("isbn")) item.isbn = data.isbn
        if (body.has("authorId")) item.authorId = data.authorId
        if (body.has("genre")) item.genre = data.genre
        if (body.has("pages")) item.pages = data.pages
        if (body.has("published")) item.published = data.published
        if (body.has("available")) item.available = data.available
    }

    /** List books. */
    suspend fun listBooks(query: ListQuery): ListResult<Book> = repository.list(query)

    /** Get a book. */
    suspend fun getBook(key: JsonUuid): Book = find(key)

    /** Create a book. */
    suspend fun createBook(body: Body<BookCreate>): Book {
        val item = Book()
        apply(item, body)
        checkReferences(item)
        return repository.add(item)
    }

    /** Replace a book: every field the client may send takes the value of the body. */
    suspend fun replaceBook(key: JsonUuid, body: Body<BookCreate>): Book {
        val item = find(key)
        apply(item, body)
        checkReferences(item)
        return repository.update(item)
    }

    /** Update part of a book: only the fields in the body change. */
    suspend fun updateBook(key: JsonUuid, body: Body<BookUpdate>): Book {
        val item = find(key)
        applyChanges(item, body)
        checkReferences(item)
        return repository.update(item)
    }

    /** Delete a book. */
    suspend fun deleteBook(key: JsonUuid) {
        find(key)
        repository.delete(key)
    }
}
