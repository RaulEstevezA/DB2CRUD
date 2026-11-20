package com.example.model;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

@Converter(autoApply = true)
public class GenreConverter implements AttributeConverter<Genre, String> {
    @Override
    public String convertToDatabaseColumn(Genre value) {
        return value == null ? null : value.getValue();
    }

    @Override
    public Genre convertToEntityAttribute(String value) {
        if (value == null) return null;
        for (Genre candidate : Genre.values()) if (candidate.getValue().equals(value)) return candidate;
        throw new IllegalArgumentException("Unknown Genre: " + value);
    }
}
