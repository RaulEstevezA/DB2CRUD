package com.example.api.common;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.HashSet;
import java.util.Set;

/**
 * Base of request bodies. Jackson calls a setter only for properties present in the JSON, so the
 * setters record them: a property sent as null is present, a missing one is not.
 */
public abstract class Payload {

    @JsonIgnore
    private final Set<String> present = new HashSet<>();

    /** Records that the property with this JSON name was sent. */
    protected void mark(String property) {
        present.add(property);
    }

    /** Whether the property with this JSON name was sent, even as null. */
    public boolean has(String property) {
        return present.contains(property);
    }
}
