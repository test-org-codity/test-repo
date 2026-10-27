from src.policy_e2e_probe import average

def test_average_nonempty_values() -> None:
    assert average([2, 4]) == 3.0
