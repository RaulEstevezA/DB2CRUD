import jakarta.validation.constraints.Size;

public enum Role { READER, WRITER, ADMIN }

public class UserRequest {
    private Long id;
    @Size(max = 100)
    private String userName;
    private String age;
    private Role role;
    private String teamTitle;
    private java.time.LocalDate joined;
}

public class UserResponse {
    private Long id;
    private String userName;
}

public class Team {
    private Integer id;
    private String title;
    private String motto;
}
