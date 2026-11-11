package com.example.api.common;

import java.util.List;

/** A window of items and how many match, whatever the window. */
public record ListResult<T>(List<T> items, long total) {
}
