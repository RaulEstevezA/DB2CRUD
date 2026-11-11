package com.example.api.model;

import com.example.api.common.ApiException;
import com.fasterxml.jackson.annotation.JsonValue;

/** Values of Genre, with the value each one has in JSON. */
public enum Genre {
    NOVEL("novel"),
    ESSAY("essay"),
    POETRY("poetry"),
    SCIENCE("science");

    private final String value;

    Genre(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    /** The constant with this JSON value; an unknown value is a 400. */
    public static Genre fromValue(String value) {
        for (Genre item : values()) {
            if (item.value.equals(value)) {
                return item;
            }
        }
        throw ApiException.invalid("Genre", "Unknown value: " + value);
    }
}
