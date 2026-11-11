package com.example.api.dto;

import java.time.OffsetDateTime;

import com.example.api.model.Address;
import com.example.api.model.Customer;
import com.fasterxml.jackson.annotation.JsonInclude;

/** A customer as the API returns it. */
public record CustomerResponse(
        Long id,
        String name,
        String email,
        @JsonInclude(JsonInclude.Include.NON_NULL) String phone,
        Address address,
        OffsetDateTime createdAt
) {

    /** The response of a stored customer: everything but what clients only send. */
    public static CustomerResponse from(Customer item) {
        return new CustomerResponse(item.getId(), item.getName(), item.getEmail(), item.getPhone(), item.getAddress(), item.getCreatedAt());
    }
}
