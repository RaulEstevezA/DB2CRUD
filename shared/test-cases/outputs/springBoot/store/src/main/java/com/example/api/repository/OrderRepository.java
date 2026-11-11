package com.example.api.repository;

import java.util.Optional;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Order;

/** Where orders are kept. The service depends only on this interface. */
public interface OrderRepository {

    /** Items equal to every filter, in order, within the window; and how many match. */
    ListResult<Order> list(ListQuery query);

    /** The item with this key, if there is one. */
    Optional<Order> get(Long key);

    /** Stores a new item and assigns its key; returns it as stored. */
    Order add(Order item);

    /** Stores the new state of an existing item and returns it. */
    Order update(Order item);

    /** Removes an existing item. */
    void delete(Long key);
}
