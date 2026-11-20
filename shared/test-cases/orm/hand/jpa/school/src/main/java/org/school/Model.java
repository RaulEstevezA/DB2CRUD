package org.school;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.*;
import org.hibernate.annotations.Check;
import org.hibernate.annotations.ColumnDefault;
import org.hibernate.annotations.Comment;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.OnDelete;
import org.hibernate.annotations.OnDeleteAction;
import org.hibernate.type.SqlTypes;

enum Level { BASIC, MIDDLE, HIGH }

@Embeddable
class Address {
    private String street;
    @Column(length = 60)
    private String city;
}

@Embeddable
class EnrollmentId implements java.io.Serializable {
    @Column(name = "student_id")
    private UUID studentId;
    @Column(name = "course_code", length = 8)
    private String courseCode;
}

@Entity
@Table(name = "students", schema = "academic", uniqueConstraints = @UniqueConstraint(name = "uq_students_email", columnNames = "email"))
@Comment("People who study")
class Student extends Audited {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String email;

    @Lob
    private String biography;

    @Enumerated(EnumType.STRING)
    @Column(length = 10)
    private Level level = Level.BASIC;

    private Level ordinal;

    @JdbcTypeCode(SqlTypes.JSON)
    private Map<String, Object> preferences;

    @Embedded
    @AttributeOverride(name = "street", column = @Column(name = "home_street"))
    private Address address;

    private int credits;

    @Transient
    private String display;

    @ManyToMany
    private Set<Course> courses = new HashSet<>();

    @OneToOne(mappedBy = "student")
    private Locker locker;

    protected Student() {}

    public <T> T visit(java.util.function.Function<Student, T> visitor) {
        return visitor.apply(this);
    }
}

@Entity
@Check(name = "ck_course_fee", constraints = "fee >= 0")
class Course {
    @Id
    @Column(length = 8)
    private String code;

    @Column(columnDefinition = "varchar(120) not null")
    private String title;

    @Column(precision = 8, scale = 2)
    @ColumnDefault("0")
    private BigDecimal fee;

    @Comment("First day")
    private LocalDate starts;

    @ManyToOne
    @OnDelete(action = OnDeleteAction.SET_NULL)
    private Teacher teacher;

    @ManyToMany(mappedBy = "courses")
    private List<Student> students;
}

@Entity(name = "Teacher")
@Table(indexes = { @Index(name = "ix_teacher_name", columnList = "name ASC, room DESC"), @Index(columnList = "room", unique = true) })
class Teacher {
    @Id
    @GeneratedValue
    private Long id;

    private String name;

    private Short room;

    @OneToMany(mappedBy = "teacher")
    private List<Course> courses;
}

@Entity
@Table(name = "lockers")
class Locker {
    @Id
    private Integer number;

    @OneToOne(optional = false)
    @JoinColumn(name = "student_id", foreignKey = @ForeignKey(name = "fk_lockers_student"))
    private Student student;
}

@Entity
@Table(name = "enrollments")
class Enrollment {
    @EmbeddedId
    private EnrollmentId id;

    @Check(constraints = "grade between 0 and 10")
    private Double grade;

    @ManyToOne
    @JoinColumns({
        @JoinColumn(name = "student_id", referencedColumnName = "id", insertable = false, updatable = false),
    })
    private Student student;

    record Summary(String code, double grade) {}
}
