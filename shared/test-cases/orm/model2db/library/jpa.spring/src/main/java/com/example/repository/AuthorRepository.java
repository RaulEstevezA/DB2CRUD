package com.example.repository;

import com.example.model.Author;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface AuthorRepository extends JpaRepository<Author, UUID> {}
