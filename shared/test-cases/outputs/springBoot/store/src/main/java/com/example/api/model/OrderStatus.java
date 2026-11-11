package com.example.api.model;

import com.example.api.common.ApiException;
import com.fasterxml.jackson.annotation.JsonValue;

/** Values of OrderStatus, with the value each one has in JSON. */
public enum OrderStatus {
    PENDING("pending"),
    PAID("paid"),
    SHIPPED("shipped"),
    CANCELLED("cancelled");

    private final String value;

    OrderStatus(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    /** The constant with this JSON value; an unknown value is a 400. */
    public static OrderStatus fromValue(String value) {
        for (OrderStatus item : values()) {
            if (item.value.equals(value)) {
                return item;
            }
        }
        throw ApiException.invalid("OrderStatus", "Unknown value: " + value);
    }
}
