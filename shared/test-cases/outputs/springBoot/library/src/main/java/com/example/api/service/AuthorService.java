package com.example.api.service;

import java.util.UUID;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.AuthorCreate;
import com.example.api.dto.AuthorUpdate;
import com.example.api.model.Author;
import com.example.api.repository.AuthorRepository;
import org.springframework.stereotype.Service;

/** Rules of authors: what each operation checks and changes. */
@Service
public class AuthorService {

    private final AuthorRepository repository;

    public AuthorService(AuthorRepository repository) {
        this.repository = repository;
    }

    private Author find(UUID key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("author"));
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Author item, AuthorCreate data) {
        item.setName(data.getName());
        item.setEmail(data.has("email") ? data.getEmail() : null);
        item.setBorn(data.has("born") ? data.getBorn() : null);
    }

    private void applyChanges(Author item, AuthorUpdate data) {
        rejectNull(data.has("name"), data.getName(), "name");
        if (data.has("name")) {
            item.setName(data.getName());
        }
        if (data.has("email")) {
            item.setEmail(data.getEmail());
        }
        if (data.has("born")) {
            item.setBorn(data.getBorn());
        }
    }

    /** List authors. */
    public ListResult<Author> listAuthors(ListQuery query) {
        return repository.list(query);
    }

    /** Get an author. */
    public Author getAuthor(UUID key) {
        return find(key);
    }

    /** Create an author. */
    public Author createAuthor(AuthorCreate data) {
        Author item = new Author();
        apply(item, data);
        return repository.add(item);
    }

    /** Replace an author: every field the client may send takes the value of the body. */
    public Author replaceAuthor(UUID key, AuthorCreate data) {
        Author item = find(key);
        apply(item, data);
        return repository.update(item);
    }

    /** Update part of an author: only the fields in the body change. */
    public Author updateAuthor(UUID key, AuthorUpdate data) {
        Author item = find(key);
        applyChanges(item, data);
        return repository.update(item);
    }

    /** Delete an author. */
    public void deleteAuthor(UUID key) {
        find(key);
        repository.delete(key);
    }
}
