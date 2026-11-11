package com.example.api.repository;

import java.util.Optional;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Category;

/** Where categories are kept. The service depends only on this interface. */
public interface CategoryRepository {

    /** Items equal to every filter, in order, within the window; and how many match. */
    ListResult<Category> list(ListQuery query);

    /** The item with this key, if there is one. */
    Optional<Category> get(Long key);

    /** Stores a new item and assigns its key; returns it as stored. */
    Category add(Category item);

    /** Stores the new state of an existing item and returns it. */
    Category update(Category item);

    /** Removes an existing item. */
    void delete(Long key);
}
