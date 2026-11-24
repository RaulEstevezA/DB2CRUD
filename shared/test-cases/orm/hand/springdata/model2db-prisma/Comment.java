package com.example.document;

import org.springframework.data.mongodb.core.mapping.Field;
import java.time.Instant;

/** Embedded value written by Model2DB from User. Review it before using it. */
public class Comment {
    private String text;

    @Field("written_at")
    private Instant writtenAt;

    private Integer rating;

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public Instant getWrittenAt() {
        return writtenAt;
    }

    public void setWrittenAt(Instant writtenAt) {
        this.writtenAt = writtenAt;
    }

    public Integer getRating() {
        return rating;
    }

    public void setRating(Integer rating) {
        this.rating = rating;
    }
}
