<?php

declare(strict_types=1);

namespace Shop;

use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

enum Priority: int
{
    case Low = 1;
    case High = 9;
}

enum Kind
{
    case Physical;
    case Digital;
}

#[ORM\MappedSuperclass]
abstract class Timestamped
{
    #[ORM\Column(name: 'created_at', type: Types::DATETIMETZ_IMMUTABLE, options: ['default' => 'CURRENT_TIMESTAMP'])]
    protected \DateTimeImmutable $createdAt;
}

#[ORM\Embeddable]
class Money
{
    #[ORM\Column(type: Types::DECIMAL, precision: 12, scale: 2)]
    private string $amount = '0';

    #[ORM\Column(length: 3, options: ['fixed' => true])]
    private string $currency = 'EUR';
}

#[ORM\Entity]
#[ORM\Table(name: 'products', schema: 'catalog', options: ['comment' => 'What the shop sells'])]
#[ORM\UniqueConstraint(name: 'uq_products_sku', fields: ['sku'])]
#[ORM\Index(columns: ['name', 'kind'])]
class Product extends Timestamped
{
    #[ORM\Id, ORM\GeneratedValue, ORM\Column]
    private ?int $id = null;

    #[ORM\Column(length: 40)]
    private string $sku;

    #[ORM\Column(type: 'text', nullable: true, options: ['comment' => 'Shown in the catalog'])]
    private ?string $name = null;

    #[ORM\Column]
    private Priority $priority = Priority::Low;

    #[ORM\Column(enumType: Kind::class, length: 10)]
    private Kind $kind;

    #[ORM\Column]
    private bool $active = true;

    #[ORM\Column(type: Types::JSON)]
    private array $tags = [];

    #[ORM\Column(insertable: false, updatable: false, generated: 'ALWAYS', columnDefinition: "INTEGER GENERATED ALWAYS AS (length(sku)) STORED")]
    private int $skuLength;

    #[ORM\Embedded(class: Money::class)]
    private Money $price;

    #[ORM\Embedded(class: Money::class, columnPrefix: false)]
    private Money $cost;

    #[ORM\ManyToOne(targetEntity: Category::class, inversedBy: 'products')]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Category $category = null;

    #[ORM\ManyToMany(targetEntity: Supplier::class)]
    private Collection $suppliers;

    public function __construct()
    {
        $this->suppliers = new ArrayCollection();
    }
}

#[ORM\Entity]
class Category
{
    #[ORM\Id]
    #[ORM\Column(type: Types::GUID)]
    #[ORM\GeneratedValue(strategy: 'NONE')]
    private string $id;

    #[ORM\OneToMany(targetEntity: Product::class, mappedBy: 'category')]
    private Collection $products;

    #[ORM\OneToOne(targetEntity: Category::class)]
    #[ORM\JoinColumn(name: 'parent_id', referencedColumnName: 'id', nullable: true, onDelete: 'CASCADE')]
    private ?Category $parent = null;
}

#[ORM\Entity]
#[ORM\Table('suppliers')]
class Supplier
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'IDENTITY')]
    #[ORM\Column(type: Types::BIGINT)]
    private ?int $id = null;

    #[ORM\Column(type: Types::DATE_MUTABLE, nullable: true)]
    private ?\DateTime $since = null;
}
