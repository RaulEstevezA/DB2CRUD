package com.example.api.dto;

import java.math.BigDecimal;

import com.example.api.model.Item;

/** An item as the API returns it. */
public record ItemResponse(
        Long id,
        String name,
        BigDecimal price,
        String supplierEmail,
        Long categoryId,
        Integer stock
) {

    /** The response of a stored item: everything but what clients only send. */
    public static ItemResponse from(Item item) {
        return new ItemResponse(item.getId(), item.getName(), item.getPrice(), item.getSupplierEmail(), item.getCategoryId(), item.getStock());
    }
}
