package com.example.api.model;

import jakarta.validation.constraints.NotNull;

/** Address, embedded in the resources that hold it. */
public record Address(
        @NotNull String street,
        @NotNull String city,
        @NotNull String postalCode,
        @NotNull String country
) {
}
