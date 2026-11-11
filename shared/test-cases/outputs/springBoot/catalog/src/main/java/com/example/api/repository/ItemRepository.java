package com.example.api.repository;

import java.util.Optional;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Item;

/** Where items are kept. The service depends only on this interface. */
public interface ItemRepository {

    /** Items equal to every filter, in order, within the window; and how many match. */
    ListResult<Item> list(ListQuery query);

    /** The item with this key, if there is one. */
    Optional<Item> get(Long key);

    /** Stores a new item and assigns its key; returns it as stored. */
    Item add(Item item);

    /** Stores the new state of an existing item and returns it. */
    Item update(Item item);

    /** Removes an existing item. */
    void delete(Long key);
}
