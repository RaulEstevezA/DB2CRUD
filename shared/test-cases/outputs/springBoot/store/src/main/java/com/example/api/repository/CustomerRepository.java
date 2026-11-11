package com.example.api.repository;

import java.util.Optional;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Customer;

/** Where customers are kept. The service depends only on this interface. */
public interface CustomerRepository {

    /** Items equal to every filter, in order, within the window; and how many match. */
    ListResult<Customer> list(ListQuery query);

    /** The item with this key, if there is one. */
    Optional<Customer> get(Long key);

    /** Stores a new item and assigns its key; returns it as stored. */
    Customer add(Customer item);

    /** Stores the new state of an existing item and returns it. */
    Customer update(Customer item);

    /** Removes an existing item. */
    void delete(Long key);
}
