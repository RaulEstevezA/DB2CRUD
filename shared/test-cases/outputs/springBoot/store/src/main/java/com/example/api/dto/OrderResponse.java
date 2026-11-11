package com.example.api.dto;

import java.time.OffsetDateTime;
import java.util.List;

import com.example.api.model.Order;
import com.example.api.model.OrderLine;
import com.example.api.model.OrderStatus;
import com.fasterxml.jackson.annotation.JsonInclude;

/** An order as the API returns it. */
public record OrderResponse(
        Long id,
        Long customerId,
        List<OrderLine> lines,
        OrderStatus status,
        Double total,
        @JsonInclude(JsonInclude.Include.NON_NULL) String notes,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
) {

    /** The response of a stored order: everything but what clients only send. */
    public static OrderResponse from(Order item) {
        return new OrderResponse(item.getId(), item.getCustomerId(), item.getLines(), item.getStatus(), item.getTotal(), item.getNotes(), item.getCreatedAt(), item.getUpdatedAt());
    }
}
