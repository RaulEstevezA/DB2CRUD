package com.example.api.dto;

import java.time.LocalDate;
import java.util.UUID;

import com.example.api.model.Author;

/** An author as the API returns it. */
public record AuthorResponse(
        UUID id,
        String name,
        String email,
        LocalDate born
) {

    /** The response of a stored author: everything but what clients only send. */
    public static AuthorResponse from(Author item) {
        return new AuthorResponse(item.getId(), item.getName(), item.getEmail(), item.getBorn());
    }
}
