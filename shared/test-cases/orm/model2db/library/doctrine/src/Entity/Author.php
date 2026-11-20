<?php

namespace App\Entity;

use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/** Entity written by Model2DB from Book. Review it before using it. */
#[ORM\Entity]
#[ORM\Table(name: 'authors')]
class Author
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: Types::GUID)]
    private string $id;

    #[ORM\Column(name: 'name', type: Types::STRING, length: 120)]
    private string $name;

    #[ORM\Column(name: 'email', type: Types::TEXT, nullable: true)]
    private ?string $email = null;

    #[ORM\Column(name: 'born', type: Types::DATE_IMMUTABLE, nullable: true)]
    private ?\DateTimeImmutable $born = null;

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getEmail(): ?string
    {
        return $this->email;
    }

    public function setEmail(?string $email): static
    {
        $this->email = $email;

        return $this;
    }

    public function getBorn(): ?\DateTimeImmutable
    {
        return $this->born;
    }

    public function setBorn(?\DateTimeImmutable $born): static
    {
        $this->born = $born;

        return $this;
    }
}
