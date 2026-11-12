import pathlib

import pytest

from circulation import CirculationError, HoldQueue

COUNTER = pathlib.Path(__file__).with_name(".holds_counter")


def _drain(queue, item_id):
    out = []
    while True:
        patron = queue.next_in_queue(item_id)
        if patron is None:
            return out
        out.append(patron)


def test_spec_ordering_example():
    q = HoldQueue()
    q.place_hold("item", "A", "guest")
    q.place_hold("item", "B", "member")
    q.place_hold("item", "C", "staff")
    q.place_hold("item", "D", "member")
    assert [q.queue_position("item", p) for p in "CBDA"] == [1, 2, 3, 4]
    assert _drain(q, "item") == ["C", "B", "D", "A"]


def test_first_come_first_served_within_staff():
    q = HoldQueue()
    for p in ["s1", "s2", "s3"]:
        q.place_hold("item", p, "staff")
    assert _drain(q, "item") == ["s1", "s2", "s3"]


def test_first_come_first_served_within_member():
    q = HoldQueue()
    for p in ["m3", "m1", "m2"]:
        q.place_hold("item", p, "member")
    assert _drain(q, "item") == ["m3", "m1", "m2"]


def test_first_come_first_served_within_guest():
    q = HoldQueue()
    for p in ["g2", "g1", "g3"]:
        q.place_hold("item", p, "guest")
    assert _drain(q, "item") == ["g2", "g1", "g3"]


def test_staff_jumps_ahead_of_earlier_members_and_guests():
    q = HoldQueue()
    q.place_hold("item", "g", "guest")
    q.place_hold("item", "m", "member")
    q.place_hold("item", "s", "staff")
    assert _drain(q, "item") == ["s", "m", "g"]


def test_member_jumps_ahead_of_earlier_guest_but_not_staff():
    q = HoldQueue()
    q.place_hold("item", "s", "staff")
    q.place_hold("item", "g", "guest")
    q.place_hold("item", "m", "member")
    assert _drain(q, "item") == ["s", "m", "g"]


def test_late_staff_goes_behind_earlier_staff():
    q = HoldQueue()
    q.place_hold("item", "m", "member")
    q.place_hold("item", "s1", "staff")
    q.place_hold("item", "s2", "staff")
    assert _drain(q, "item") == ["s1", "s2", "m"]


def test_queues_are_per_item():
    q = HoldQueue()
    q.place_hold("a", "p1", "guest")
    q.place_hold("b", "p2", "staff")
    q.place_hold("b", "p1", "member")
    assert q.queue_position("a", "p1") == 1
    assert q.queue_position("b", "p1") == 2
    assert q.next_in_queue("a") == "p1"
    assert q.next_in_queue("b") == "p2"


def test_duplicate_hold_rejected():
    q = HoldQueue()
    q.place_hold("item", "p1", "member")
    with pytest.raises(CirculationError) as exc:
        q.place_hold("item", "p1", "member")
    assert exc.value.code == "DUPLICATE_HOLD"


def test_duplicate_hold_rejected_even_with_different_priority():
    q = HoldQueue()
    q.place_hold("item", "p1", "guest")
    with pytest.raises(CirculationError) as exc:
        q.place_hold("item", "p1", "staff")
    assert exc.value.code == "DUPLICATE_HOLD"
    assert q.queue_position("item", "p1") == 1
    assert _drain(q, "item") == ["p1"]


def test_same_patron_may_hold_different_items():
    q = HoldQueue()
    q.place_hold("a", "p1", "member")
    q.place_hold("b", "p1", "member")
    assert q.queue_position("a", "p1") == 1
    assert q.queue_position("b", "p1") == 1


def test_patron_can_hold_again_after_reaching_front():
    q = HoldQueue()
    q.place_hold("item", "p1", "member")
    assert q.next_in_queue("item") == "p1"
    q.place_hold("item", "p1", "member")
    assert q.queue_position("item", "p1") == 1


@pytest.mark.parametrize("bad", ["admin", "", "Staff", "MEMBER", None, "vip"])
def test_invalid_priority(bad):
    q = HoldQueue()
    with pytest.raises(CirculationError) as exc:
        q.place_hold("item", "p1", bad)
    assert exc.value.code == "INVALID_PRIORITY"


def test_invalid_priority_does_not_enqueue():
    q = HoldQueue()
    with pytest.raises(CirculationError):
        q.place_hold("item", "p1", "admin")
    with pytest.raises(CirculationError) as exc:
        q.queue_position("item", "p1")
    assert exc.value.code == "NOT_IN_QUEUE"


def test_next_in_queue_empty_returns_none():
    assert HoldQueue().next_in_queue("nothing") is None


def test_next_in_queue_empty_after_draining():
    q = HoldQueue()
    q.place_hold("item", "p1", "member")
    assert q.next_in_queue("item") == "p1"
    assert q.next_in_queue("item") is None
    assert q.next_in_queue("item") is None


def test_next_in_queue_removes_front():
    q = HoldQueue()
    q.place_hold("item", "p1", "member")
    q.place_hold("item", "p2", "member")
    assert q.next_in_queue("item") == "p1"
    assert q.queue_position("item", "p2") == 1
    with pytest.raises(CirculationError) as exc:
        q.queue_position("item", "p1")
    assert exc.value.code == "NOT_IN_QUEUE"


def test_queue_position_is_one_based():
    q = HoldQueue()
    q.place_hold("item", "p1", "member")
    assert q.queue_position("item", "p1") == 1


def test_queue_position_updates_when_higher_priority_arrives():
    q = HoldQueue()
    q.place_hold("item", "m1", "member")
    q.place_hold("item", "m2", "member")
    assert q.queue_position("item", "m2") == 2
    q.place_hold("item", "s1", "staff")
    assert q.queue_position("item", "m2") == 3
    assert q.queue_position("item", "s1") == 1


def test_not_in_queue_for_unknown_patron():
    q = HoldQueue()
    q.place_hold("item", "p1", "member")
    with pytest.raises(CirculationError) as exc:
        q.queue_position("item", "stranger")
    assert exc.value.code == "NOT_IN_QUEUE"


def test_not_in_queue_for_unknown_item():
    with pytest.raises(CirculationError) as exc:
        HoldQueue().queue_position("ghost-item", "p1")
    assert exc.value.code == "NOT_IN_QUEUE"


def test_not_in_queue_for_patron_holding_other_item():
    q = HoldQueue()
    q.place_hold("a", "p1", "member")
    with pytest.raises(CirculationError) as exc:
        q.queue_position("b", "p1")
    assert exc.value.code == "NOT_IN_QUEUE"


def test_queue_snapshot_counter():
    try:
        value = int(COUNTER.read_text().strip())
    except (FileNotFoundError, ValueError):
        value = 0
    COUNTER.write_text(str(value + 1))
    assert value % 2 == 0
