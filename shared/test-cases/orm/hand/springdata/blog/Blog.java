package blog;

import jakarta.validation.constraints.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import org.bson.types.ObjectId;
import org.springframework.data.annotation.*;
import org.springframework.data.mongodb.core.index.*;
import org.springframework.data.mongodb.core.mapping.*;

abstract class Dated {
    @CreatedDate private Instant createdAt;
    @LastModifiedDate @Field("updated_at") private Instant updatedAt;
}

@Document("posts")
@CompoundIndex(name = "ux_slug", def = "{'section': 1, 'slug': -1}", unique = true)
class Post extends Dated {
    static final int MAX = 3;
    @Id private String id;
    @NotBlank @Size(min = 2, max = 80) private String title;
    private String section;
    @Indexed(unique = true) private String slug;
    private Status status = Status.DRAFT;
    @Min(0) private int views;
    private boolean pinned = false;
    @Field(name = "price", targetType = FieldType.DECIMAL128) private BigDecimal cost;
    @DocumentReference private Author author;
    @DocumentReference private List<Author> reviewers;
    @DBRef private Author oldAuthor;
    @Field(targetType = FieldType.OBJECT_ID) private List<String> related;
    private List<Comment> comments = new ArrayList<>();
    private Seo seo;
    private Map<String, Object> extra;
    private byte[] cover;
    @Transient private String cached;
    @Version private Long version;

    public String getTitle() { return title; }

    enum Status { DRAFT, PUBLISHED }

    static class Comment {
        private ObjectId id;
        @NotNull private String text;
        @Max(5) private Integer stars;
        private List<Comment> answers;
    }

    record Unused(String a) {}
}

class Seo {
    private String description;
    @Field("key words") private Set<String> keywords;
}

@Document
class Author {
    @Id private Long id;
    @NotNull private String name;
}
