"""What every output is made of. Mirrors web/src/core/generate/types.ts.

A writer is an object with `id`, `label`, `group`, optionally `engines` (SQL engines the user can choose) and
`migrations` (whether it can add a migration), and `write(physical, context)`, which returns the files as
dictionaries with `name`, `content` and `editorLanguage`. The context holds `schema`, `design`, `settings`,
`title` and `note(note)`."""

from dataclasses import dataclass, field

from ..model.naming import to_snake_case

# Groups of the output selector
OUTPUT_GROUPS = ("relational", "document", "keyvalue", "widecolumn", "python", "typescript", "jvm", "csharp", "php")


def generated_file(name: str, content: str, editor_language: str) -> dict:
    return {"name": name, "content": content, "editorLanguage": editor_language}


@dataclass
class WriteContext:
    schema: dict
    design: dict
    settings: dict
    # The model the schema is mainly about: names the files
    title: str
    # What the output could not write as the design says, shown with the result
    notes: list = field(default_factory=list)

    def note(self, note: dict) -> None:
        self.notes.append(note)


def file_base(title: str) -> str:
    """Base of file names: the main model in snake_case (`order_line`)."""
    return to_snake_case(title) or "schema"
