package com.example.api.dto;

import com.example.api.model.Category;
import com.fasterxml.jackson.annotation.JsonInclude;

/** A category as the API returns it. */
public record CategoryResponse(
        Long id,
        String name,
        @JsonInclude(JsonInclude.Include.NON_NULL) Long parentId
) {

    /** The response of a stored category: everything but what clients only send. */
    public static CategoryResponse from(Category item) {
        return new CategoryResponse(item.getId(), item.getName(), item.getParentId());
    }
}
