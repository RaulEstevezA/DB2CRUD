package com.example.api.service;

import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.BookCreate;
import com.example.api.dto.BookUpdate;
import com.example.api.model.Book;
import com.example.api.repository.AuthorRepository;
import com.example.api.repository.BookRepository;
import org.springframework.stereotype.Service;

/** Rules of books: what each operation checks and changes. */
@Service
public class BookService {

    private final BookRepository repository;
    private final AuthorRepository authorRepository;

    public BookService(BookRepository repository, AuthorRepository authorRepository) {
        this.repository = repository;
        this.authorRepository = authorRepository;
    }

    private Book find(UUID key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("book"));
    }

    /** A reference must point to a stored item. */
    private static <K> void require(Function<K, Optional<?>> lookup, K key, String field, String model) {
        if (key != null && lookup.apply(key).isEmpty()) {
            throw ApiException.invalid(field, "No " + model + " has this key");
        }
    }

    private void checkReferences(Book item) {
        require(authorRepository::get, item.getAuthorId(), "authorId", "Author");
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Book item, BookCreate data) {
        rejectNull(data.has("available"), data.getAvailable(), "available");
        item.setTitle(data.getTitle());
        item.setIsbn(data.getIsbn());
        item.setAuthorId(data.getAuthorId());
        item.setGenre(data.getGenre());
        item.setPages(data.getPages());
        item.setPublished(data.has("published") ? data.getPublished() : null);
        item.setAvailable(data.has("available") ? data.getAvailable() : true);
    }

    private void applyChanges(Book item, BookUpdate data) {
        rejectNull(data.has("title"), data.getTitle(), "title");
        rejectNull(data.has("isbn"), data.getIsbn(), "isbn");
        rejectNull(data.has("authorId"), data.getAuthorId(), "authorId");
        rejectNull(data.has("genre"), data.getGenre(), "genre");
        rejectNull(data.has("pages"), data.getPages(), "pages");
        rejectNull(data.has("available"), data.getAvailable(), "available");
        if (data.has("title")) {
            item.setTitle(data.getTitle());
        }
        if (data.has("isbn")) {
            item.setIsbn(data.getIsbn());
        }
        if (data.has("authorId")) {
            item.setAuthorId(data.getAuthorId());
        }
        if (data.has("genre")) {
            item.setGenre(data.getGenre());
        }
        if (data.has("pages")) {
            item.setPages(data.getPages());
        }
        if (data.has("published")) {
            item.setPublished(data.getPublished());
        }
        if (data.has("available")) {
            item.setAvailable(data.getAvailable());
        }
    }

    /** List books. */
    public ListResult<Book> listBooks(ListQuery query) {
        return repository.list(query);
    }

    /** Get a book. */
    public Book getBook(UUID key) {
        return find(key);
    }

    /** Create a book. */
    public Book createBook(BookCreate data) {
        Book item = new Book();
        apply(item, data);
        checkReferences(item);
        return repository.add(item);
    }

    /** Replace a book: every field the client may send takes the value of the body. */
    public Book replaceBook(UUID key, BookCreate data) {
        Book item = find(key);
        apply(item, data);
        checkReferences(item);
        return repository.update(item);
    }

    /** Update part of a book: only the fields in the body change. */
    public Book updateBook(UUID key, BookUpdate data) {
        Book item = find(key);
        applyChanges(item, data);
        checkReferences(item);
        return repository.update(item);
    }

    /** Delete a book. */
    public void deleteBook(UUID key) {
        find(key);
        repository.delete(key);
    }
}
