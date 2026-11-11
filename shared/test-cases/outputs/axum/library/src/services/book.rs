//! Rules of books: what each operation checks and changes.

use std::sync::Arc;

use uuid::Uuid;

use crate::common::body::Body;
use crate::common::error::ApiError;
use crate::common::list::{ListQuery, ListResult};
use crate::dtos::book::BookCreate;
use crate::dtos::book::BookUpdate;
use crate::models::book::Book;
use crate::repositories::author::AuthorRepository;
use crate::repositories::book::BookFilters;
use crate::repositories::book::BookRepository;

/// Rules of books.
pub struct BookService {
    repository: Arc<dyn BookRepository>,
    author_repository: Arc<dyn AuthorRepository>,
}

impl BookService {
    pub fn new(repository: Arc<dyn BookRepository>, author_repository: Arc<dyn AuthorRepository>) -> Self {
        Self { repository, author_repository }
    }

    async fn find(&self, key: Uuid) -> Result<Book, ApiError> {
        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found("book"))
    }

    /// Every reference must point to a stored item.
    async fn check_references(&self, item: &Book) -> Result<(), ApiError> {
        if let Some(reference0) = &item.author_id
            && self.author_repository.get(reference0.clone()).await?.is_none()
        {
            return Err(ApiError::invalid("authorId", "No Author has this key"));
        }
        Ok(())
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    fn apply(item: &mut Book, body: &Body<BookCreate>) {
        let data = &body.value;
        item.title = data.title.clone();
        item.isbn = data.isbn.clone();
        item.author_id = data.author_id.clone();
        item.genre = data.genre.clone();
        item.pages = data.pages.clone();
        item.published = if body.has("published") { data.published.clone() } else { None };
        item.available = if body.has("available") { data.available.clone() } else { Some(true) };
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    fn apply_changes(item: &mut Book, body: &Body<BookUpdate>) {
        let data = &body.value;
        if body.has("title") {
            item.title = data.title.clone();
        }
        if body.has("isbn") {
            item.isbn = data.isbn.clone();
        }
        if body.has("authorId") {
            item.author_id = data.author_id.clone();
        }
        if body.has("genre") {
            item.genre = data.genre.clone();
        }
        if body.has("pages") {
            item.pages = data.pages.clone();
        }
        if body.has("published") {
            item.published = data.published.clone();
        }
        if body.has("available") {
            item.available = data.available.clone();
        }
    }

    /// List books.
    pub async fn list_books(&self, query: ListQuery<BookFilters>) -> Result<ListResult<Book>, ApiError> {
        self.repository.list(&query).await
    }

    /// Get a book.
    pub async fn get_book(&self, key: Uuid) -> Result<Book, ApiError> {
        self.find(key).await
    }

    /// Create a book.
    pub async fn create_book(&self, body: Body<BookCreate>) -> Result<Book, ApiError> {
        let mut item = Book::default();
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.add(item).await
    }

    /// Replace a book: every field the client may send takes the value of the body.
    pub async fn replace_book(&self, key: Uuid, body: Body<BookCreate>) -> Result<Book, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.update(item).await
    }

    /// Update part of a book: only the fields in the body change.
    pub async fn update_book(&self, key: Uuid, body: Body<BookUpdate>) -> Result<Book, ApiError> {
        let mut item = self.find(key).await?;
        Self::apply_changes(&mut item, &body);
        self.check_references(&item).await?;
        self.repository.update(item).await
    }

    /// Delete a book.
    pub async fn delete_book(&self, key: Uuid) -> Result<(), ApiError> {
        self.find(key.clone()).await?;
        self.repository.delete(key).await
    }
}
