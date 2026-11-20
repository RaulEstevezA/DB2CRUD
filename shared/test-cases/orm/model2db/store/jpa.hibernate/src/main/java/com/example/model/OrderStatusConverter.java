package com.example.model;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

@Converter(autoApply = true)
public class OrderStatusConverter implements AttributeConverter<OrderStatus, String> {
    @Override
    public String convertToDatabaseColumn(OrderStatus value) {
        return value == null ? null : value.getValue();
    }

    @Override
    public OrderStatus convertToEntityAttribute(String value) {
        if (value == null) return null;
        for (OrderStatus candidate : OrderStatus.values()) if (candidate.getValue().equals(value)) return candidate;
        throw new IllegalArgumentException("Unknown OrderStatus: " + value);
    }
}
