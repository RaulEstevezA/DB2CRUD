package com.example.api.repository;

import java.util.Optional;
import java.util.UUID;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Book;

/** Where books are kept. The service depends only on this interface. */
public interface BookRepository {

    /** Items equal to every filter, in order, within the window; and how many match. */
    ListResult<Book> list(ListQuery query);

    /** The item with this key, if there is one. */
    Optional<Book> get(UUID key);

    /** Stores a new item and assigns its key; returns it as stored. */
    Book add(Book item);

    /** Stores the new state of an existing item and returns it. */
    Book update(Book item);

    /** Removes an existing item. */
    void delete(UUID key);
}
