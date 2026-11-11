package com.example.api.model;

import java.time.LocalDate;
import java.util.UUID;

/** An author as the service and its storage handle it. */
public class Author {

    private UUID id;

    private String name;

    private String email;

    private LocalDate born;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        this.email = email;
    }

    public LocalDate getBorn() {
        return born;
    }

    public void setBorn(LocalDate born) {
        this.born = born;
    }
}
