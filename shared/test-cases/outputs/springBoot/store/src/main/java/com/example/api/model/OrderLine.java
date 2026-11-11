package com.example.api.model;

import jakarta.validation.constraints.NotNull;

/** OrderLine, embedded in the resources that hold it. */
public record OrderLine(
        @NotNull Long productId,
        @NotNull Double quantity,
        @NotNull Double unitPrice
) {
}
