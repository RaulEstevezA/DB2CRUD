from db2crud.core.generators.samples import bounded_number
from db2crud.core.schema.checks import check_of


def bounds(*checks: str) -> list[dict]:
    return [check_of(check)["parsed"] for check in checks]


def test_numbers_stay_within_the_bounds_of_the_checks():
    assert bounded_number([], "n", False) == "n"
    assert bounded_number(bounds("a >= 5"), "n", False) == "5 + n"
    assert bounded_number(bounds("a >= 1", "a <= 5"), "$n", False) == "1 + $n % 5"
    assert bounded_number(bounds("a > 0", "a < 5"), "n", False) == "1 + n % 4"
    assert bounded_number(bounds("a <= 100"), "n", False) == "n % 101"
    assert bounded_number(bounds("a >= 0", "a <= 5"), "n", True) == "n % 5"
    assert bounded_number(bounds("a >= 0", "a <= 100000"), "n", False) == "n"
