package com.example.api.dto;

import java.time.LocalDate;
import java.util.UUID;

import com.example.api.model.Book;
import com.example.api.model.Genre;

/** A book as the API returns it. */
public record BookResponse(
        UUID id,
        String title,
        String isbn,
        UUID authorId,
        Genre genre,
        Integer pages,
        LocalDate published,
        Boolean available
) {

    /** The response of a stored book: everything but what clients only send. */
    public static BookResponse from(Book item) {
        return new BookResponse(item.getId(), item.getTitle(), item.getIsbn(), item.getAuthorId(), item.getGenre(), item.getPages(), item.getPublished(), item.getAvailable());
    }
}
