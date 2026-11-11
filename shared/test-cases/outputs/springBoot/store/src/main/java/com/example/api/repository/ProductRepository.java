package com.example.api.repository;

import java.util.Optional;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Product;

/** Where products are kept. The service depends only on this interface. */
public interface ProductRepository {

    /** Items equal to every filter, in order, within the window; and how many match. */
    ListResult<Product> list(ListQuery query);

    /** The item with this key, if there is one. */
    Optional<Product> get(Long key);

    /** Stores a new item and assigns its key; returns it as stored. */
    Product add(Product item);

    /** Stores the new state of an existing item and returns it. */
    Product update(Product item);

    /** Removes an existing item. */
    void delete(Long key);
}
