package com.example.api.dto;

import java.time.LocalDate;
import java.util.UUID;

import com.example.api.common.Payload;
import com.example.api.model.Genre;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** Body of a request that creates or replaces a book. */
public class BookCreate extends Payload {

    @NotNull
    @Size(min = 1, max = 200)
    private String title;

    @NotNull
    @Pattern(regexp = "^[0-9]{13}$")
    private String isbn;

    @NotNull
    private UUID authorId;

    @NotNull
    private Genre genre;

    @NotNull
    @DecimalMin("1")
    @DecimalMax("5000")
    private Integer pages;

    private LocalDate published;

    private Boolean available;

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        mark("title");
        this.title = title;
    }

    public String getIsbn() {
        return isbn;
    }

    public void setIsbn(String isbn) {
        mark("isbn");
        this.isbn = isbn;
    }

    public UUID getAuthorId() {
        return authorId;
    }

    public void setAuthorId(UUID authorId) {
        mark("authorId");
        this.authorId = authorId;
    }

    public Genre getGenre() {
        return genre;
    }

    public void setGenre(Genre genre) {
        mark("genre");
        this.genre = genre;
    }

    public Integer getPages() {
        return pages;
    }

    public void setPages(Integer pages) {
        mark("pages");
        this.pages = pages;
    }

    public LocalDate getPublished() {
        return published;
    }

    public void setPublished(LocalDate published) {
        mark("published");
        this.published = published;
    }

    public Boolean getAvailable() {
        return available;
    }

    public void setAvailable(Boolean available) {
        mark("available");
        this.available = available;
    }
}
