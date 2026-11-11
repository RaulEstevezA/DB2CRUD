package com.example.api.dto;

import java.time.LocalDate;

import com.example.api.common.Payload;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Size;

/** Body of a request that changes part of an author: only the fields sent change. */
public class AuthorUpdate extends Payload {

    @Size(min = 2, max = 120)
    private String name;

    @Email
    private String email;

    private LocalDate born;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        mark("name");
        this.name = name;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        mark("email");
        this.email = email;
    }

    public LocalDate getBorn() {
        return born;
    }

    public void setBorn(LocalDate born) {
        mark("born");
        this.born = born;
    }
}
