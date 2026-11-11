"""The generated projects against shared/test-cases/: every framework for every built-in example with the
default settings (outputs/), and the scenarios with other settings and edits (variants/). The web version
writes and checks the same files (web/src/core/generators/shared.test.ts)."""

import json

import pytest

from model2api.core.api.spec import resolve_api
from model2api.core.compatibility.stack import DEFAULT_SETTINGS, FRAMEWORKS, normalize_settings
from model2api.core.design.edit import add_custom_endpoint, decide, update_endpoint
from model2api.core.design.propose import propose_design
from model2api.core.importers.registry import parse_input
from model2api.examples import EXAMPLES, find_example

from .conftest import SHARED_CASES

OUTPUTS = SHARED_CASES / "outputs"
VARIANTS = sorted((SHARED_CASES / "variants").glob("*.json"))


def apply_edit(design: dict, edit: dict) -> dict:
    """An edit as the variants hold it: a call to design/edit without its first argument."""
    args = edit["args"]
    if edit["edit"] == "decide":
        return decide(design, *args)
    if edit["edit"] == "updateEndpoint":
        return update_endpoint(design, *args)
    return add_custom_endpoint(design, *args)["design"]


def files_of(example_id: str, settings: dict, edits: list[dict]) -> dict[str, str]:
    from model2api.core.generators.registry import generate_project

    example = find_example(example_id)
    outcome = parse_input(example["text"], example["format"])
    assert outcome["ok"]
    schema = outcome["schema"]
    design = propose_design(schema)
    for edit in edits:
        design = apply_edit(design, edit)
    resolved = normalize_settings({**DEFAULT_SETTINGS, "name": example["project"], **settings})
    files = generate_project(resolve_api(schema, design, resolved), resolved)
    return {file["path"]: file["content"] for file in files}


def compare(files: dict[str, str], expected: dict[str, str]) -> None:
    assert sorted(files) == sorted(expected)
    for path, content in expected.items():
        assert files[path] == content, path
    # The same order as the web version, which sorts with compareText
    assert list(files) == list(expected)


def read_tree(folder) -> dict[str, str]:
    paths = [path for path in folder.rglob("*") if path.is_file()]
    files = {path.relative_to(folder).as_posix(): path.read_text(encoding="utf-8") for path in paths}
    from model2api.core.generators.common.text import compare_key

    return dict(sorted(files.items(), key=lambda item: compare_key(item[0])))


@pytest.mark.parametrize("example", EXAMPLES, ids=lambda example: example["id"])
@pytest.mark.parametrize("framework", FRAMEWORKS, ids=lambda framework: framework["id"])
def test_outputs(framework, example):
    skip_unless_ported(framework["id"])
    expected = read_tree(OUTPUTS / framework["id"] / example["id"])
    compare(files_of(example["id"], {"framework": framework["id"]}, []), expected)


@pytest.mark.parametrize("path", VARIANTS, ids=lambda path: path.stem)
def test_variants(path):
    variant = json.loads(path.read_text(encoding="utf-8"))
    skip_unless_ported(variant["settings"]["framework"])
    compare(files_of(variant["example"], variant["settings"], variant["edits"]), variant["files"])


def skip_unless_ported(framework_id: str) -> None:
    from model2api.core.generators.registry import find_generator

    if find_generator(framework_id) is None:
        pytest.skip(f"the {framework_id} generator is not ported yet")
