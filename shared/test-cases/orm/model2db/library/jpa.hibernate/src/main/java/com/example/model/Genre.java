package com.example.model;

/** The values of Genre as the database stores them. */
public enum Genre {
    NOVEL("novel"),
    ESSAY("essay"),
    POETRY("poetry"),
    SCIENCE("science");

    private final String value;

    Genre(String value) {
        this.value = value;
    }

    public String getValue() {
        return value;
    }
}
