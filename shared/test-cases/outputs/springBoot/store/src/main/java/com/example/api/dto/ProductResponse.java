package com.example.api.dto;

import com.example.api.model.Product;
import com.fasterxml.jackson.annotation.JsonInclude;

/** A product as the API returns it. */
public record ProductResponse(
        Long id,
        String sku,
        String name,
        @JsonInclude(JsonInclude.Include.NON_NULL) String description,
        Double price,
        Double stock,
        Boolean active
) {

    /** The response of a stored product: everything but what clients only send. */
    public static ProductResponse from(Product item) {
        return new ProductResponse(item.getId(), item.getSku(), item.getName(), item.getDescription(), item.getPrice(), item.getStock(), item.getActive());
    }
}
