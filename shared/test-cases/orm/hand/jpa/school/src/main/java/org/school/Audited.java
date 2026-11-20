package org.school;

import jakarta.persistence.Column;
import jakarta.persistence.MappedSuperclass;
import jakarta.persistence.Version;
import java.time.Instant;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

/** What every table keeps about its rows. */
@MappedSuperclass
public abstract class Audited {
    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    protected Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at")
    protected Instant updatedAt;

    @Version
    private long version;

    public static final int PAGE = 20;
}
