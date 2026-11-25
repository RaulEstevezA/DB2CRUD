import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

public enum Level { basic, gold }

public enum LineStatus { pending, sent }

public record Location(double latitude, double longitude) {}

public record Address(String street, String zipCode, Location location) {}

public record Customer(String id, String email, Level level, Instant since, Address address, List<String> tags) {}

public class Discount {
    private String reason;
    private double percent;

    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
    public double getPercent() { return percent; }
    public void setPercent(double percent) { this.percent = percent; }
}

public class OrderLine {
    private String id;
    private String sku;
    private int quantity;
    private BigDecimal price;
    private LineStatus status;
    private List<Discount> discounts;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getSku() { return sku; }
    public void setSku(String sku) { this.sku = sku; }
    public int getQuantity() { return quantity; }
    public void setQuantity(int quantity) { this.quantity = quantity; }
    public BigDecimal getPrice() { return price; }
    public void setPrice(BigDecimal price) { this.price = price; }
    public LineStatus getStatus() { return status; }
    public void setStatus(LineStatus status) { this.status = status; }
    public List<Discount> getDiscounts() { return discounts; }
    public void setDiscounts(List<Discount> discounts) { this.discounts = discounts; }
}

public record Shipping(String carrier, LocalDate sentOn) {}

public record Order(String id, String code, List<OrderLine> lines, Shipping shipping) {}

public record Parcel(double weight, String size, boolean fragile) {}

public record Shipment(String id, Parcel parcel, List<String> stops) {}
